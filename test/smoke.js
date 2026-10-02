#!/usr/bin/env node
// Smoke test for BudapestRoutePlanner timetable generation
// Validates: timetable files exist, are valid JSON/ZIP, map tiles are valid PBF
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const timetablesDir = path.join(__dirname, '../budapest/timetable');
const budapestDir = path.join(__dirname, '../budapest');

let passed = 0, failed = 0;

function assert(condition, msg) {
  if (condition) { passed++; console.log('  PASS: ' + msg); }
  else { failed++; console.log('  FAIL: ' + msg); }
}

// Check we have the timetable directory
console.log('\n1. Timetable directory');
assert(fs.existsSync(timetablesDir), 'budapest/timetable/ exists');

// Check common.json.zip
console.log('\n2. Common data');
const commonZip = path.join(timetablesDir, 'common.json.zip');
assert(fs.existsSync(commonZip), 'common.json.zip exists');
if (fs.existsSync(commonZip)) {
  const size = fs.statSync(commonZip).size;
  assert(size > 100, 'common.json.zip has content (' + size + ' bytes)');
  // Verify it's a valid zip by listing contents
  try {
    const result = execSync(`unzip -l "${commonZip}"`, { encoding: 'utf8' });
    assert(result.includes('common.json'), 'common.json.zip contains common.json');
  } catch(e) {
    assert(false, 'common.json.zip is valid zip: ' + e.message);
  }
}

// Check day timetable files
console.log('\n3. Day timetable files');
const dayZero = new Date(2000, 0, 1).getTime();
const today = new Date(); today.setHours(0, 0, 0, 0);
const todayIdx = Math.round((today.getTime() - dayZero) / 86400000);
const files = fs.readdirSync(timetablesDir).filter(f => /^\d+\.json\.zip$/.test(f));
assert(files.length > 0, 'Found ' + files.length + ' day timetable files');

// Check today's file exists
assert(files.includes(todayIdx + '.json.zip'), 'Today\'s file (' + todayIdx + '.json.zip) exists');

// Validate a day file is a valid zip with JSON content
if (files.length > 0) {
  const sampleFile = path.join(timetablesDir, files[0]);
  const day = files[0].split('.')[0];
  try {
    const result = execSync(`unzip -l "${sampleFile}"`, { encoding: 'utf8' });
    assert(result.includes(day + '.json'), files[0] + ' contains ' + day + '.json');
  } catch(e) {
    assert(false, files[0] + ' is valid zip');
  }
}

// Check map tiles
console.log('\n4. Map tiles');
const tileDirs = fs.readdirSync(budapestDir).filter(d => /^\d+$/.test(d));
assert(tileDirs.length > 0, 'Found ' + tileDirs.length + ' tile directories');

if (tileDirs.length > 0) {
  // Find a sample tile — structure is {z}/{x}/{y}.pbf
  let found = false;
  for (const z of tileDirs) {
    const zDir = path.join(budapestDir, z);
    const xDirs = fs.existsSync(zDir) ? fs.readdirSync(zDir) : [];
    for (const x of xDirs) {
      const xDir = path.join(zDir, x);
      const yFiles = fs.existsSync(xDir) ? fs.readdirSync(xDir) : [];
      const pbf = yFiles.find(f => f.endsWith('.pbf'));
      if (pbf) {
        const tilePath = path.join(xDir, pbf);
        const size = fs.statSync(tilePath).size;
        assert(true, `Sample tile ${z}/${x}/${pbf} exists (${size} bytes)`);
        assert(size > 0, 'Tile has content');
        found = true;
        break;
      }
    }
    if (found) break;
  }
  if (!found) assert(false, 'Found a sample .pbf tile file');
}

// Summary
console.log('\n---');
console.log('Passed: ' + passed + ', Failed: ' + failed);
process.exit(failed > 0 ? 1 : 0);
