import { createRequire } from 'module';
const require = createRequire(import.meta.url);

var fs = require('fs');

function read(f) {return fs.readFileSync(f).toString();}
function include(f, preamble='') {eval.apply(global, [preamble+' '+read(f)]);}

//var turf = require('turf');
//import * as turf from 'turf'
include('turf.min.js');
var point = turf.point([-75.343, 39.984]);

const dir = 'budapest/timetable'
if (!fs.existsSync(dir)){
    fs.mkdirSync(dir);
}
class ProgressLinearizer { // dummy class for gtfs.js
	constructor(a,b){}
	update(a){}
	load(){return Promise.resolve(0);}
}
var p= new ProgressLinearizer(0,0);

console.log('0');
eval(fs.readFileSync('jszip.min.js')+'');
console.log('1');
include('gtfs.js');
console.log('gtfs:',walkSpeed, GTFS);

include('walk_route.js');
include('bridgeBuilder.js', "");

var allGeoJson = fs.readFileSync('all.geojson');
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

const todayInt = parseInt(new Date().toISOString().split('T')[0].replace(/-/g, ''), 10);

for(var day = common.range[0]; day<=common.range[1]; day++) {
	// Skip past days
	if (day < todayInt) continue;
	// Limit to next N days when --days=N is specified
	if (maxDays !== null) {
		const dayDate = new Date(
			Math.floor(day / 10000),
			Math.floor((day % 10000) / 100) - 1,
			day % 100
		);
		const daysFromNow = Math.round((dayDate - new Date(new Date().toISOString().split('T')[0])) / 86400000);
		if (daysFromNow >= maxDays) break;
	}
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

