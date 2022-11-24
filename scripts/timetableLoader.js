
async function LoadTimeTable()
{
	var startTime = performance.now(), downloadEndTime=0, extractEndTime=0, parseEndTime=0;
	const dayNum = date2days((new Date()).toISOString().split('T')[0]);
	var urls = [timetable_url+'common.json.zip', timetable_url+dayNum+'.json.zip'];
	var progresses = [];

	var gtfsRoutes = null;
	try {
		const zipBlobs = await DownloadFiles(urls, progresses);
		downloadEndTime = performance.now();
		const zipContents = await ExtractZips(zipBlobs);
		extractEndTime = performance.now();
		const objects = ParseJsons(zipContents);
		parseEndTime = performance.now();
		console.log('zip timetables parsed');

		if(objects[0].range[0] != objects[1].c_range[0] || objects[0].range[1] != objects[1].c_range[1])
		{
			console.log('reloading common');
			const d2StartTime = performance.now();
			const zipBlobs = await DownloadFiles([urls[0]], progresses, {cache: "reload"});
			const d2EndTime = performance.now();
			downloadEndTime += d2EndTime - d2StartTime;
			const zipContents = await ExtractZips(zipBlobs);
			const e2EndTime = performance.now();
			extractEndTime += e2EndTime - d2StartTime;
			const commonObjs = ParseJsons(zipContents);
			const p2EndTime = performance.now();
			parseEndTime += p2EndTime - d2StartTime;
			objects[0] = commonObjs[0];
			if(objects[0].range[0] != objects[1].c_range[0] || objects[0].range[1] != objects[1].c_range[1])
			{
				throw 'common and daily timetable mismatch!';
			}
		}
		gtfsRoutes = initRoutes(objects[0], objects[1], dayNum);
	}catch(e){
		console.log(e);
	}

	var initEndTime = performance.now();
	const perfStr = `init took ${((initEndTime - startTime)/1000).toFixed(3)} seconds\n - download: ${((downloadEndTime - startTime)/1000).toFixed(3)}\n - extract: ${((extractEndTime - downloadEndTime)/1000).toFixed(3)}\n - parse: ${((parseEndTime - extractEndTime)/1000).toFixed(3)}\n - ctor: ${((initEndTime - parseEndTime)/1000).toFixed(3)}`
	console.log(perfStr);
	return {'routes':gtfsRoutes, 'perf':perfStr};
}

async function DownloadFiles(urls, progresses, fetchParams={})
{
	var blobsPromises = urls.map(async (url, ind) => {
		progresses.unshift([0,0]);
		var downloaded = 0;
		var chunks = [];
		var response = await fetch(urls[ind], fetchParams);
		const reader = response.body.getReader();

		const total = parseInt(response.headers.get('Content-Length'));

		while(true) {
		  const {done, value} = await reader.read();
		  if (done) { break; }

		  chunks.push(value);
		  downloaded += value.length;
		  
		  progresses[ind]=[downloaded, total];
		  const wholeDownloaded = progresses.reduce((prevVal,curVal)=>prevVal+curVal[0],0);
		  const wholeTotal = progresses.reduce((prevVal,curVal)=>prevVal+curVal[1],0);
		  postMessage({'progress':[`Timetable downloading ${humanReadableSize(wholeDownloaded)}/${humanReadableSize(wholeTotal)}`, wholeDownloaded / wholeTotal]});
		}

		return new Blob(chunks);
	});
	return Promise.all(blobsPromises);
}
async function ExtractZips(zipBlobs)
{
	const zipContentPromises = zipBlobs.map(async (blob,i) => {
		var zip = new JSZip();
		zip = await zip.loadAsync(blob);
		console.log('zip-parsed', zip, zip.files);
		return Object.values(zip.files)[0].async("string");
	});
	return Promise.all(zipContentPromises);
}
function ParseJsons(strings)
{
	const objects = strings.map(str => {
		return JSON.parse(str);
	});
	return objects;
}