// ── LEAD STORE ──
// Persists acquisition leads (one per marketplace listing).
// Uses Supabase when configured, otherwise a local JSON file (fine for dev / single server).
//
// Supabase table:
//   create table leads (
//     id text primary key,
//     data jsonb not null,
//     updated_at timestamptz default now()
//   );
//   create table suppressions (
//     contact text primary key,          -- normalised phone or lowercase email
//     reason text,
//     created_at timestamptz default now()
//   );

import fs from 'node:fs/promises';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';

const { SUPABASE_URL, SUPABASE_SERVICE_KEY, DATA_DIR = './data' } = process.env;

const supabase = SUPABASE_URL && SUPABASE_SERVICE_KEY
  ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  : null;

const FILE = path.join(DATA_DIR, 'leads.json');

// In-memory cache for the file backend
let cache = null;

async function loadFile() {
  if (cache) return cache;
  try {
    cache = JSON.parse(await fs.readFile(FILE, 'utf8'));
  } catch {
    cache = { leads: {}, suppressions: {} };
  }
  return cache;
}

let writing = Promise.resolve();
function saveFile() {
  // Serialise writes so concurrent saves don't clobber each other
  writing = writing.then(async () => {
    await fs.mkdir(DATA_DIR, { recursive: true });
    const tmp = FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(cache, null, 2));
    await fs.rename(tmp, FILE);
  });
  return writing;
}

export async function getLead(id) {
  if (supabase) {
    const { data, error } = await supabase.from('leads').select('data').eq('id', id).maybeSingle();
    if (error) throw error;
    return data?.data || null;
  }
  const db = await loadFile();
  return db.leads[id] || null;
}

export async function listLeads() {
  if (supabase) {
    const { data, error } = await supabase.from('leads').select('data').order('updated_at', { ascending: false });
    if (error) throw error;
    return data.map(r => r.data);
  }
  const db = await loadFile();
  return Object.values(db.leads);
}

export async function saveLead(lead) {
  lead.updatedAt = new Date().toISOString();
  if (supabase) {
    const { error } = await supabase.from('leads').upsert({ id: lead.id, data: lead, updated_at: lead.updatedAt });
    if (error) throw error;
    return lead;
  }
  const db = await loadFile();
  db.leads[lead.id] = lead;
  await saveFile();
  return lead;
}

export async function findLeadByContact(contact) {
  const leads = await listLeads();
  // Most recently updated lead wins if a seller has several listings
  return leads
    .filter(l => l.seller?.phone === contact || l.seller?.email === contact)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''))[0] || null;
}

export async function isSuppressed(contact) {
  if (!contact) return false;
  if (supabase) {
    const { data } = await supabase.from('suppressions').select('contact').eq('contact', contact).maybeSingle();
    return !!data;
  }
  const db = await loadFile();
  return !!db.suppressions[contact];
}

export async function suppress(contact, reason = 'opt-out') {
  if (!contact) return;
  if (supabase) {
    await supabase.from('suppressions').upsert({ contact, reason });
    return;
  }
  const db = await loadFile();
  db.suppressions[contact] = { reason, at: new Date().toISOString() };
  await saveFile();
}
