// Materialize the publish/unpublish notebooks as real notebook objects under
// the SP's workspace home, so notebook_task can reference them regardless of
// how the app source was deployed (DAB vs Marketplace). The Apps artifact
// snapshot stores .py files as plain workspace files, not notebooks, so we
// can't point notebook_task at them directly; we re-import them through
// /api/2.0/workspace/import which performs the SOURCE -> notebook conversion.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { workspaceMkdirsSp, workspaceImportNotebookSp } from './dbx.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC_DIR = path.join(__dirname, '..', 'notebooks');

const NOTEBOOKS = ['bdc_publish', 'bdc_unpublish'];

let cache;
let inFlight;

function spHomeDir() {
  const cid = process.env.DATABRICKS_CLIENT_ID;
  if (!cid) {
    const err = new Error('DATABRICKS_CLIENT_ID is not set; cannot resolve SP home for notebook import');
    err.status = 500; err.code = 'missing_client_id';
    throw err;
  }
  return `/Workspace/Users/${cid}/bdc-publisher`;
}

async function readSource(name) {
  // The Apps platform strips the .py extension when materializing notebook
  // .py files into the source snapshot. Try the stripped form first (what
  // we'll actually see at runtime), fall back to the .py form (local dev or
  // platforms that preserve the extension).
  for (const candidate of [path.join(SRC_DIR, name), path.join(SRC_DIR, `${name}.py`)]) {
    try { return await fs.readFile(candidate); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  }
  const err = new Error(`Notebook source ${name} not found under ${SRC_DIR}`);
  err.status = 500; err.code = 'notebook_source_missing';
  throw err;
}

async function importOne(name, dir) {
  const buf = await readSource(name);
  const target = `${dir}/${name}`;
  await workspaceImportNotebookSp({
    path: target,
    contentBase64: buf.toString('base64'),
    language: 'PYTHON',
  });
  return target;
}

async function doEnsure() {
  const dir = spHomeDir();
  await workspaceMkdirsSp(dir);
  const entries = await Promise.all(NOTEBOOKS.map((n) => importOne(n, dir).then((p) => [n, p])));
  return Object.fromEntries(entries);
}

export async function ensureNotebooks() {
  if (cache) return cache;
  if (!inFlight) inFlight = doEnsure().then((r) => { cache = r; inFlight = null; return r; }, (e) => { inFlight = null; throw e; });
  return inFlight;
}

export function clearNotebookCache() {
  cache = undefined;
  inFlight = undefined;
}
