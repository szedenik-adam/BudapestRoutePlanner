
var gtfs_urls = ['https://bprp.pages.dev/budapest_gtfs.zipaa','https://bprp.pages.dev/budapest_gtfs.zipab','https://bprp.pages.dev/budapest_gtfs.zipac'];
var timetable_url = 'https://bprp.pages.dev/timetable/';

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

var gtfsRoutes, db, stopInfoProvider = null, cachedRealtimeVehicleFeed = null;

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

	var timetableInfo = await LoadTimeTable();
	gtfsRoutes = timetableInfo.routes;
	
	if(cachedRealtimeVehicleFeed) {
		ProcessRealTimeVehicleFeed(cachedRealtimeVehicleFeed.vehicles);
		postMessage(cachedRealtimeVehicleFeed);
		cachedRealtimeVehicleFeed = null;
	}
	
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
	else if('taskNum' in e.data) {
		var sendResponse = true;
		if('task' in e.data) {
			if(e.data.task=='gtfs-rt') {
				if('vehicles' in e.data) {
					if(gtfsRoutes) {
						ProcessRealTimeVehicleFeed(e.data.vehicles);
					} else {
						cachedRealtimeVehicleFeed = e.data;
						sendResponse = false;
					}
					//console.log('WORKER gtfs-rt',e.data);
				}
			}
		}
		if(sendResponse) { postMessage(e.data); }
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
		if(e.data.task=='timing') {
			const src = {lat:e.data.src[0], lon:e.data.src[1]};
			for(var target of e.data.targets) { target.arrivals = {}; target.quickArrivals = {}; target.check = true; target.checkQuick = true; }
			
			for(const startTimeDelayMinutes of [0,1,3,5,7]) {
				const startTime = Date.now() + startTimeDelayMinutes*60000;
				var checkQuickRoutes = false;
				for(var target of e.data.targets) {
					if(!target.check) {
						if(target.checkQuick) {checkQuickRoutes = true;}
						continue;
					}
					var duration = route(src, {lat:target.dst[0],lon:target.dst[1]}, gtfsRoutes, {ret:'duration',startTime:startTime});
					target.arrivals[startTimeDelayMinutes] = duration*1000+startTime;
					if(duration*1000+startTime > target.expiration) { checkQuickRoutes = true; target.check = false;}
				}
				if(startTimeDelayMinutes==7 && !checkQuickRoutes) {e.data.last=true;}
				postMessage(e.data);
				console.log('gtfs timing', e.data);

				if(checkQuickRoutes) {
					delete gtfsRoutes.last;
					walkSpeed *= 2;
					transferWait /= 2;
					try {
						for(var target of e.data.targets) {
							if(!target.checkQuick) {continue;}
								if(target.arrivals[startTimeDelayMinutes]===undefined || target.arrivals[startTimeDelayMinutes] > target.expiration) {
								var duration = route(src, {lat:target.dst[0],lon:target.dst[1]}, gtfsRoutes, {ret:'duration',startTime:startTime});
								target.quickArrivals[startTimeDelayMinutes] = duration*1000+startTime;
								if(duration*1000+startTime > target.expiration) { target.checkQuick = false;}
							}
						}
					} catch(e){console.log('Exception in quick route calculation',e);}
					walkSpeed /= 2;
					transferWait *= 2;
					if(startTimeDelayMinutes==7) {e.data.last=true;}
					postMessage(e.data);
					console.log('gtfs quick timing', e.data);
				}
			}
		}
	}
}

function ProcessRealTimeVehicleFeed(vehicles)
{
	const nowSec = Date.now()/1000;
	vehicles.entity.forEach(e => {
		const originalRouteId = e.vehicle.trip.route_id;
		if(!originalRouteId) {return;}
		const routeId = gtfsRoutes.routeMap[originalRouteId];
		if(!routeId) {return;}
		const route = gtfsRoutes.routes[routeId];
		if(!route) {return;}
		e.vehicle.vehicle.label = route.name+' > '+e.vehicle.vehicle.label;
		UpdateTripTimes(gtfsRoutes, e.vehicle, nowSec);
	});
}
function UpdateTripTimes(data, vehicle, nowSec)
{
	// Get trip for vehicle
	const tripInd = data.tripMap[vehicle.trip.trip_id];
	// If null -> stop
	if(tripInd === undefined) return;
	var trip = data.trips[tripInd];
	// Find the vehicle's next stop in trip.stops
	const vstopId = data.stopMap[vehicle.stop_id];
	if(vstopId === undefined) return;
	var tstopInd = 0;
	while(trip.stops[tstopInd]._id != vstopId && tstopInd < trip.stops.length) {tstopInd++;}
	if(tstopInd == trip.stops.length) return;
	// If nextStopInd == 0 then don't do anything
	if(tstopInd == 0) return;
	// Next stop arrival time: (vehicleDistanceToStop/prevStopDistanceToStop)*(arrivalToStop-arrivalToPrevStop) - (Now - vehiclePosTimestamp)
	const prevStopDistanceToStop = trip.stopShapeDist[tstopInd] - trip.stopShapeDist[tstopInd-1];
	const remainingTransitRatio = vehicle.vehicle[".realcity.vehicle"].stop_distance / prevStopDistanceToStop;
	const calculatedArrivalInSec = remainingTransitRatio * (trip.stopArr[tstopInd] - trip.stopArr[tstopInd-1]) - (nowSec - vehicle.timestamp);
	const calculatedArrivalTime = (nowSec % 86400)+calculatedArrivalInSec+(new Date().getTimezoneOffset())*-60; // TODO: change %86400 to handle overlapping days.
	// Calculate diff between expected arrival and calculated arrival
	const delay = calculatedArrivalTime - trip.stopArr[tstopInd];
	
	for(var si = 0; si < tstopInd; si++) {
		trip.stopDep[si]=Math.min(trip.stopArr[si], trip.stopArr[si]+delay);
	}
	// Apply diff to each stopArr and stopDep array element in trip
	for(var si = tstopInd; si < trip.stops.length; si++) {
		trip.stopDep[si]=trip.stopArr[si]+delay;
	}
}
