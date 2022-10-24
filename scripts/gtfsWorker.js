
var gtfs_urls = ['https://bprp.pages.dev/budapest_gtfs.zipaa','https://bprp.pages.dev/budapest_gtfs.zipab','https://bprp.pages.dev/budapest_gtfs.zipac'];
var timetable_url = 'https://bprp.pages.dev/timetable/';

postMessage('initializing');

importScripts('progressLinearizer.js');
importScripts('gtfs.js');
try{importScripts('local.js');}catch(e){}
importScripts('external/jszip.min.js');
importScripts('external/idb.min.js');

var gtfs, gtfsRoutes, db;

async function getFeedAgeDays()
{
	let tx = db.transaction('cache');
	let cacheStore = tx.objectStore('cache');
	let caches = await cacheStore.getAll();
	if (caches.length == 0) return 1000;
	if (!('date' in caches[0])) return 1000;
	return (new Date() - caches[0].date)/1000/3600/24;
}

async function initGTFS()
{
	var startTime = performance.now(), downloadEndTime=0;
	
	db = await idb.openDb('gtfs', 2, db => {
		db.createObjectStore('cache', {keyPath: 'name'});
		db.createObjectStore('tables', {keyPath: 'name'});
		db.createObjectStore('extract', {keyPath: 'day'});
	});
	
	//const feedAge = await getFeedAgeDays();
	//console.log('feedAge', feedAge);
	
	var gtfs_zip = null; const dayNum = date2days((new Date()).toISOString().split('T')[0]);
	var urls = [timetable_url+'common.json.zip', timetable_url+dayNum+'.json.zip']; 
	var progresses = new Array(gtfs_urls.length).fill([0,100]);		
	var blobsPromises = urls.map((url, ind) => {
		return new Promise(function(resolve,reject){
			const xhr = new XMLHttpRequest();
			xhr.addEventListener('progress', function(e){
				progresses[ind]=[e.loaded,e.total];
				const downloaded = progresses.reduce((prevVal,curVal)=>prevVal+curVal[0],0);
				const total = progresses.reduce((prevVal,curVal)=>prevVal+curVal[1],0);
				postMessage({'progress':[`Timetable downloading ${humanReadableSize(downloaded)}/${humanReadableSize(total)}`, downloaded / total]});
			});
			xhr.onload = function(e) {
			  if (this.status == 200) {
				resolve(this.response);
			  } else {
				  console.log('rejecting json xhr', this);
				  reject(null);
			  }
			};
			xhr.open("GET", url);
			xhr.responseType = 'blob';
			xhr.send();
			return xhr;
		});
	});
	try {
		const zipBlobs = await Promise.all(blobsPromises);
		downloadEndTime = performance.now();
		const zipContentPromises = zipBlobs.map(async blob => {
			var zip = new JSZip();
			zip = await zip.loadAsync(blob);
			console.log('zip-parsed', zip, zip.files);
			return Object.values(zip.files)[0].async("string");
		});
		const zipContents = await Promise.all(zipContentPromises);
		const objects = zipContents.map(content => {
			console.log('common content', content);
			return JSON.parse(content);
		});
		console.log('zip timetables parsed');
		gtfsRoutes = initRoutes(objects[0], objects[1], dayNum);
	}catch(e){
		console.log(e);
	}

	var initEndTime = performance.now();
	const perfStr = `timetable init took ${(initEndTime - startTime)/1000} seconds (download: ${(downloadEndTime - startTime)/1000}, parse: ${(initEndTime - downloadEndTime)/1000})`
	console.log(perfStr);
	
	var result = route({lat:47.49990791402583,lon:19.080153604244394}, {lat:47.55545590531613,lon:19.043956781329452}, gtfsRoutes);
	console.log('sending route to UI thread');
	postMessage({'route':result});
	postMessage({'info':perfStr+', routing: '+result.perf_sec});
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
