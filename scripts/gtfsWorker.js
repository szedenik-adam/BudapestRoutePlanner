
var gtfs_urls = ['https://bprp.pages.dev/budapest_gtfs.zipaa','https://bprp.pages.dev/budapest_gtfs.zipab','https://bprp.pages.dev/budapest_gtfs.zipac'];

postMessage('initializing');

importScripts('progressLinearizer.js');
importScripts('walk_route.js');
importScripts('gtfs.js');
importScripts('timetableLoader.js');
try{importScripts('local.js');}catch(e){}
importScripts('external/jszip.min.js');
importScripts('external/idb.min.js');
importScripts('external/turf.min.js');

importScripts('external/long.js');
importScripts('external/s2geometry.min.js');
importScripts('s2_extension.js');
importScripts('stop_worker.js');

var gtfsRoutes, db, stopInfoProvider = null;

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
	postMessage({'info':timetableInfo.perf+'\n - routing: '+result.perf_sec});
	
	stopInfoProvider = new StopInfoProvider(gtfsRoutes.stops, 13);
}

initGTFS();

onmessage = function(e) {
	if('src' in e.data && 'dst' in e.data) {
		console.log('Worker: Message received from main script', e.data);
		var result = route({lat:e.data.src.lat,lon:e.data.src.lng}, {lat:e.data.dst.lat,lon:e.data.dst.lng}, gtfsRoutes);
		console.log('sending route to UI thread');
		postMessage({'route':result});
	}
	else if ('rowInd' in e.data && 'src' in e.data && 'row' in e.data) {
		var src = {lat:e.data.src.lat,lon:e.data.src.lng};
		e.data.row.forEach((dst, i) => {
			var result = route(src, {lat:dst.lat,lon:dst.lng}, gtfsRoutes, {ret:'duration',startTime:e.data.startTime});
			e.data.row[i] = result;
		});
		postMessage({rowInd:e.data.rowInd, row:e.data.row});
	}
	else if('task' in e.data) {
		if(e.data.task=='s2') {
			var cell = S2_PointToCell([e.data.lng, e.data.lat]);
			postMessage({task:'s2', cell:cell});
		}
		if(e.data.task=='s2bb') {
			var cells, notNeededCells = new Set();
			if(stopInfoProvider) {
				var stopInfos = stopInfoProvider.getStopsForArea(e.data.bb);
				cells = stopInfos.cells;
				notNeededCells = stopInfos.notNeededCells;
			} else {
				cells = S2_CoverPolygon(e.data.bb);
			}
			postMessage({task:'s2bb', cells:cells, multipolygon:turf.multiPolygon(Array.from(cells.values()).map(cell=>cell.geometry.coordinates)), notNeededCells:notNeededCells});
		}
		if(e.data.task=='stopInfo') {
			if(stopInfoProvider) {
				const stop = gtfsRoutes.stops[e.data.stopId];
				var stopInfo = stopInfoProvider.getDetailedStopInfo(stop);
				stopInfo.task = 'stopInfo';
				postMessage(stopInfo);
			}
		}
	}
}
