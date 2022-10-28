
var gtfs_urls = ['https://bprp.pages.dev/budapest_gtfs.zipaa','https://bprp.pages.dev/budapest_gtfs.zipab','https://bprp.pages.dev/budapest_gtfs.zipac'];
var timetable_url = 'https://bprp.pages.dev/timetable/';

postMessage('initializing');

importScripts('progressLinearizer.js');
importScripts('gtfs.js');
importScripts('timetableLoader.js');
try{importScripts('local.js');}catch(e){}
importScripts('external/jszip.min.js');
importScripts('external/idb.min.js');

var gtfsRoutes, db;

async function initGTFS()
{
	
	try {
		db = await idb.openDb('gtfs', 3, db => {
			for(const name of db.objectStoreNames) {
				db.deleteObjectStore(name)
			}
			const cacheStore = db.createObjectStore('cache', {keyPath: 'name'});
			const index = cacheStore.createIndex("timestamp", "timestamp");
			db.createObjectStore('tables', {keyPath: 'name'});
			db.createObjectStore('extract', {keyPath: 'day'});
		});
	} catch(e) {
		console.warn("Unable to open DB", e);
	}
	
	var gtfs_zip = null; 
	var timetableInfo = await LoadTimeTable();
	gtfsRoutes = timetableInfo.routes;
	
	var result = route({lat:47.49990791402583,lon:19.080153604244394}, {lat:47.55545590531613,lon:19.043956781329452}, gtfsRoutes);
	console.log('sending route to UI thread');
	postMessage({'route':result});
	postMessage({'info':timetableInfo.perf+', routing: '+result.perf_sec});
}

initGTFS();

onmessage = function(e) {
	if('src' in e.data && 'dst' in e.data) {
		console.log('Worker: Message received from main script', e.data);
		var result = route({lat:e.data.src.lat,lon:e.data.src.lng}, {lat:e.data.dst.lat,lon:e.data.dst.lng}, gtfsRoutes);
		console.log('sending route to UI thread');
		postMessage({'route':result});
	}
}
