
var gtfs_urls = ['https://bprp.pages.dev/budapest_gtfs.zipaa','https://bprp.pages.dev/budapest_gtfs.zipab','https://bprp.pages.dev/budapest_gtfs.zipac'];

postMessage('initializing');

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
	db = await idb.openDb('gtfs', 2, db => {
		db.createObjectStore('cache', {keyPath: 'name'});
		db.createObjectStore('tables', {keyPath: 'name'});
		db.createObjectStore('extract', {keyPath: 'day'});
	});
	
	const feedAge = await getFeedAgeDays();
	console.log('feedAge', feedAge);
	
	var gtfs_zip = null;
	if(feedAge > 7)
	{
		db.clearReqs = [];
		for(const tName of db.objectStoreNames) {
			const tx = db.transaction([tName], "readwrite");
			const objectStore = tx.objectStore(tName);
			const objectStoreRequest = objectStore.clear();
			db.clearReqs[tName] = objectStoreRequest;
			console.log("clear-req", objectStoreRequest);
		}
		
		var fetches = gtfs_urls.map(gtfs_url => { return fetch(gtfs_url); });
		const responses = await Promise.all(fetches);
		const blobsPromises = responses.map(response => {
			if(!response.ok) { console.log('budapest_gtfs.zip response error'); }
			return response.blob();
		});
		const blobs = await Promise.all(blobsPromises);
		gtfs_zip = new Blob(blobs);
		
		var startTimePerf = new Date();
		const tx = db.transaction('cache', 'readwrite');
		const store = tx.objectStore('cache');
		const putPromise = store.put({name:'budapest_gtfs.zip', data:gtfs_zip, date:new Date()});
		var performanceDuration = (new Date()) - startTimePerf;
		console.log(`zip added to idb in ${performanceDuration/1000} seconds`);
	} else
	{
		var startTimePerf = new Date();
		const tx = db.transaction('cache', 'readonly');
		const store = tx.objectStore('cache');
		const cachedObj = await store.get('budapest_gtfs.zip');
		gtfs_zip = cachedObj.data;
		var performanceDuration = (new Date()) - startTimePerf;
		console.log(`zip loaded from idb in ${performanceDuration/1000} seconds`);
	}
		
	
	console.log('budapest_gtfs.zip', gtfs_zip);
	var zip = new JSZip();
	zip = await zip.loadAsync(gtfs_zip);
	console.log('zip-parsed', zip);
	const agencyContent = await zip.files['agency.txt'].async("string");
	console.log('zip-file', agencyContent);
	gtfs = await GTFS(db, zip);
	console.log('gtfs is set');
	
	gtfsRoutes = gtfs.extract((new Date()).toISOString().split('T')[0]);
	console.log('gtfs-result', '..');// logging gtfsRoutes would cause huge lag on the UI thread.
	//gtfsRoutes.store(db);
	var result = route({lat:47.49990791402583,lon:19.080153604244394}, {lat:47.55545590531613,lon:19.043956781329452}, gtfsRoutes);
	console.log('sending route to UI thread');
	postMessage({'route':result});
}

initGTFS();

onmessage = function(e) {
  console.log('Worker: Message received from main script');
  const result = e.data[0] * e.data[1];
  if (isNaN(result)) {
    postMessage('Please write two numbers');
  } else {
    const workerResult = 'Result: ' + result;
    console.log('Worker: Posting message back to main script');
    postMessage(workerResult);
  }
}
