import { MongoClient } from 'mongodb';
import axios from 'axios';

let cachedClient = null;
let cachedDb = null;

async function connectToDatabase(uri) {
  if (cachedClient && cachedDb) {
    return { client: cachedClient, db: cachedDb };
  }
  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db(); // default DB from URI
  cachedClient = client;
  cachedDb = db;
  return { client, db };
}

// Fetch top notes from Apify Fragrantica Scraper API
async function fetchTopNotesFromApify(perfumeName, token) {
  try {
    const response = await axios.post(
      `https://api.apify.com/v2/actor-tasks/apify/fragrantica-scraper/run-sync-get-dataset-items?token=${token}`,
      {
        searchText: perfumeName,
        maxReviewsCount: 1,
        resultsCount: 1
      },
      { headers: { 'Content-Type': 'application/json' } }
    );

    if (response.data && response.data.length > 0) {
      const first = response.data[0];
      if (first.topNotes && Array.isArray(first.topNotes)) {
        return first.topNotes.join(', ');
      }
    }
    return '';
  } catch (error) {
    console.error('Apify top notes fetch error:', error.message);
    return '';
  }
}

export default async function handler(req, res) {
  const { MONGODB_URI, APIFY_TOKEN } = process.env;
  if (!MONGODB_URI) return res.status(500).json({ error: 'Missing MongoDB URI' });
  if (!APIFY_TOKEN) return res.status(500).json({ error: 'Missing Apify Token' });

  const { db } = await connectToDatabase(MONGODB_URI);
  const collection = db.collection('perfumes');

  try {
    if (req.method === 'GET') {
      const perfumes = await collection.find().sort({ name: 1 }).toArray();
      res.status(200).json(perfumes);
    }
    else if (req.method === 'POST') {
      const { name, status, priceBDT } = req.body;
      if (!name || !status) {
        return res.status(400).json({ error: 'Name and status are required' });
      }

      // Avoid duplicate
      const existing = await collection.findOne({ name: name.trim() });
      if (existing) return res.status(400).json({ error: 'Perfume already exists' });

      // Fetch top notes
      const topNotes = await fetchTopNotesFromApify(name.trim(), APIFY_TOKEN);

      const perfumeDoc = {
        name: name.trim(),
        status,
        priceBDT: status === 'wantToBuy' ? (priceBDT || 0) : null,
        topNotes: topNotes || '',
      };

      const insertRes = await collection.insertOne(perfumeDoc);
      res.status(201).json(insertRes.ops[0]);
    }
    else if (req.method === 'PUT') {
      const { id, topNotes, priceBDT, status } = req.body;
      if (!id) return res.status(400).json({ error: 'id is required' });

      const updateFields = {};
      if (typeof topNotes === 'string') updateFields.topNotes = topNotes;
      if (typeof priceBDT === 'number') updateFields.priceBDT = status === 'wantToBuy' ? priceBDT : null;
      if (typeof status === 'string') updateFields.status = status;

      const { ObjectId } = require('mongodb');
      const updated = await collection.findOneAndUpdate(
        { _id: new ObjectId(id) },
        { $set: updateFields },
        { returnDocument: 'after' }
      );
      if (!updated.value) return res.status(404).json({ error: 'Perfume not found' });
      res.json(updated.value);
    }
    else if (req.method === 'DELETE') {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'id query param is required' });

      const { ObjectId } = require('mongodb');
      const deleted = await collection.deleteOne({ _id: new ObjectId(id) });
      if (deleted.deletedCount === 0) return res.status(404).json({ error: 'Perfume not found' });
      res.json({ message: 'Deleted' });
    }
    else {
      res.setHeader('Allow', ['GET', 'POST', 'PUT', 'DELETE']);
      res.status(405).end(`Method ${req.method} Not Allowed`);
    }
  } catch (error) {
    console.error('API error:', error);
    res.status(500).json({ error: 'Internal Server Error' });
  }
}
