import { createRequire } from 'module';
const require = createRequire(import.meta.url);
import { fileURLToPath } from 'url';
import path from 'path';

var fs = require('fs');

// Resolve base directory: prefer repo scripts/ if it exists, otherwise use current dir
const scriptDir = fileURLToPath(import.meta.url);
const thisDir = path.dirname(scriptDir);
const repoScripts = path.resolve(thisDir, '../scripts');
const baseDir = fs.existsSync(repoScripts) ? repoScripts : thisDir;
const externalDir = path.join(baseDir, 'external');

function resolvePath(f) {
	// If absolute or exists in current dir, use as-is
	if (path.isAbsolute(f) || fs.existsSync(f)) return f;
	// Check external/ first (turf, jszip), then scripts/ root (gtfs, bridgeBuilder, walk_route)
	if (fs.existsSync(path.join(externalDir, f))) return path.join(externalDir, f);
	if (fs.existsSync(path.join(baseDir, f))) return path.join(baseDir, f);
	return f;
}

function read(f) {return fs.readFileSync(resolvePath(f)).toString();}
function include(f, preamble='') {eval.apply(global, [preamble+' '+read(f)]);}

// Resolve all.geojson: check CWD first (local map/ dir), then same dir as genDays.js
let allGeoJsonPath = 'all.geojson';
if (!fs.existsSync(allGeoJsonPath)) {
	allGeoJsonPath = path.join(thisDir, 'all.geojson');
}

//var turf = require('turf');
//import * as turf from 'turf'
include('turf.min.js');
var point = turf.point([-75.343, 39.984]);

const dir = 'budapest/timetable'
if (!fs.existsSync(dir)){
    fs.mkdirSync(dir, { recursive: true });
}
class ProgressLinearizer { // dummy class for gtfs.js
	constructor(a,b){}
	update(a){}
	load(){return Promise.resolve(0);}
}
var p= new ProgressLinearizer(0,0);

console.log('0');
eval(fs.readFileSync(resolvePath('jszip.min.js'))+'');
console.log('1');
include('gtfs.js');
console.log('gtfs:',walkSpeed, GTFS);

include('walk_route.js');
include('bridgeBuilder.js', "");

var allGeoJson = fs.readFileSync(allGeoJsonPath);
var bridgeAndWaterGeojson = JSON.parse(allGeoJson);
console.log('JSON parse ok');
var bridges = calculateBridges(bridgeAndWaterGeojson);

console.log('2');
var gtfs_zip = fs.readFileSync('budapest_gtfs.zip');

console.log('3');
var zip = new JSZip();
zip = await zip.loadAsync(gtfs_zip);
//console.log('zip-parsed', zip);
const agencyContent = await zip.files['agency.txt'].async("string");
console.log('zip-file', agencyContent);
var gtfs = await GTFS(null, zip);
console.log('gtfs is set');

var gtfsRoutes = gtfs.extract((new Date()).toISOString().split('T')[0]);
var common = gtfs.extractCommon();

common.stops.forEach( s => {
	s.neighbours.forEach(ns => {
		if(ns.s == undefined) {
			console.log('found undefined neighbour:', s, ns,'.....');
			throw 'a';
		}
	});
});

AddBridgesToRoutes(bridges, common, true);

common.stops.forEach( s => {
	s.neighbours.forEach(ns => {
		if(ns.s == undefined) {
			console.log('After bridge add, found undefined neighbour:', s, ns,'.....');
			throw 'a';
		}
	});
});
// Parse optional --days=N argument (default: all days from GTFS)
const args = process.argv.slice(2);
let maxDays = null;
for (const arg of args) {
  const match = arg.match(/^--days=(\d+)$/);
  if (match) maxDays = parseInt(match[1], 10);
}

const rangeStart = parseInt(common.range[0], 10);
const rangeEnd = parseInt(common.range[1], 10);
const todayInt = parseInt(new Date().toISOString().split('T')[0].replace(/-/g, ''), 10);
const limitDay = maxDays !== null ? todayInt + maxDays : rangeEnd;

for(var day = rangeStart; day <= rangeEnd; day++) {
	// Skip past days
	if (day < todayInt) continue;
	// Limit to next N days when --days=N is specified
	if (day > limitDay) break;
	var d = gtfs.serializeDay(day, common);
	console.log('extracted', d.start_date, day-common.range[0]+1, common.range[1]-common.range[0]+1);
	// var zip = new JSZip();
	// zip.file("content.json", JSON.stringify(d));
	// zip
	// .generateNodeStream({type:'nodebuffer',streamFiles:true})
	// .pipe(fs.createWriteStream(dir+'/'+day+'.zip'))
	// .on('finish', function () {
		// // JSZip generates a readable stream with a "end" event,
		// // but is piped here in a writable stream which emits a "finish" event.
		// console.log("zip written.");
	// });
	fs.writeFileSync(dir+'/'+day+'.json', JSON.stringify(d));
}

common.stops.forEach(s => { delete s._index; if('lands' in s) s.lands = s.lands.toString(); });
common.routes.forEach(r => delete r._index);
common.routes = compactArray(common.routes);
common.stops = compactArray(common.stops);
/*zip = new JSZip();
zip.file("common.json", JSON.stringify(common));
var zipBuff = await zip.generateAsync({type:"nodebuffer"});
fs.writeFileSync(dir+'/common.zip', zipBuff);*/
fs.writeFileSync(dir+'/common.json', JSON.stringify(common));

