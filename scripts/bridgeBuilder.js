
function calculateBridges(geoJson)
{
	var waterbody = null;
	for(const feature of geoJson.features)
	{
		console.log('feature', feature.properties.name ?? '-', feature.properties.type ?? feature.geometry.type, feature);
		if('type' in feature.properties && feature.properties.type == 'multipolygon') {
			var mpoly = turf.multiPolygon(feature.geometry.coordinates);
			if(!waterbody) waterbody = mpoly;
			else waterbody = turf.union(waterbody, mpoly);
			console.log('turf multipoly', waterbody, mpoly);
		}
	}
	var bbox = [18.71965120610534, 47.377527514856865, 19.50741191985341, 47.687812071410974];
	bbox = turf.bboxPolygon(bbox);
	var land = turf.difference(bbox, waterbody);
	var lands = [];
	for(const l of land.geometry.coordinates) {
		const tLand = turf.polygon(l);
		if(turf.area(tLand) < 3000) {console.log('skipping small area', land); continue;}
		lands.push(tLand);
		continue;
		/*var polysRes=[], reflexVertices=[], steinerPoints=[];
		decomp.makeCCW(l[0]);
		decomp.quickDecomp(l[0],polysRes,reflexVertices,steinerPoints,25,100,0);
		for(const cl of polysRes) {
			cl.push(cl[0]);
			lands.push(turf.polygon([cl]));
		}*/
	}
	console.log('land count:', lands.length);
	var bridgeStops = [];
	var bridgeMultiPoly = null;
	for(const feature of geoJson.features)
	{
		if('proposed' in feature.properties) continue;
		if('access' in feature.properties && feature.properties.access=='no') continue;
		if(feature.geometry.type == 'Polygon') {
			var commonCount = 0;
			var commons = lands.map(land => {const common = turf.intersect(land, feature); if(common){commonCount++;}return common;});
			if(commonCount > 1) {
				var ci = -1;
				const bridgeStopsSizeBeforeAdd = bridgeStops.length;
				commons.forEach((common, ind) => {
					if(!common) return;
					const center = turf.centerOfMass(common);
					ci++;
					var ref = []; for(var i=0;i<commonCount;i++){if(i!=ci)ref.push(bridgeStopsSizeBeforeAdd+i);} center.properties.ref=ref;
					bridgeStops.push(center);
					bridgeMultiPoly = bridgeMultiPoly ? turf.union(feature, bridgeMultiPoly) : feature;
				});
			}
		}
		if(feature.geometry.type == 'LineString') {
			if('highway' in feature.properties && feature.properties.highway != 'footway') continue;
			const begin = turf.point(feature.geometry.coordinates[0]);
			const end = turf.point(feature.geometry.coordinates.at(-1));
			
			var addBridge = false;
			/*if(turf.booleanContains(waterbody, turf.midpoint(begin, end)) 
				&& !turf.booleanContains(waterbody, begin)
				&& !turf.booleanContains(waterbody, end)) {
				addBridge = true;
			}else*/{
				var beginPolyInd = -1, endPolyInd = -1;
				for(var i=0; i<lands.length; i++) {
					if(beginPolyInd == -1 && turf.booleanWithin(begin, lands[i])) {
						beginPolyInd = i;
					}
					if(endPolyInd == -1 && turf.booleanWithin(end, lands[i])) {
						endPolyInd = i;
					}
					if(beginPolyInd != -1 && endPolyInd != -1) {
						if(beginPolyInd != endPolyInd) {
							addBridge = true;
						}
						break;
					}
				}
			}
			if(addBridge) {
				var beginMergeInd=null, endMergeInd=null;
				bridgeStops.forEach((bs,bi) => {
					if(turf.distance(bs, begin) < 0.1) beginMergeInd=bi;
					if(turf.distance(bs, end) < 0.1) endMergeInd=bi;
				});
				begin.properties.ref=[endMergeInd ?? bridgeStops.length+1];
				end.properties.ref=[beginMergeInd ?? bridgeStops.length];
				if(!beginMergeInd) bridgeStops.push(begin);
				if(!endMergeInd) bridgeStops.push(end);
				
				const bridgePoly = turf.buffer(feature, 0.04, {units: 'kilometers'});
				bridgeMultiPoly = bridgeMultiPoly ? turf.union(bridgePoly, bridgeMultiPoly) : bridgePoly;
			}
		}
	}
	var bridgeStopPolys = []
	if(bridgeStops) {
		const c = turf.featureCollection(bridgeStops);
		const oldStopCount = bridgeStops.length;
		const clusteredStops = turf.clustersDbscan(c, 0.03, {minPoints:1, mutate:true, units:'kilometers'});
		bridgeStops.forEach(stop => stop.properties.refclusters = new Set(stop.properties.ref.map(ref => bridgeStops[ref].properties.cluster)));
		
		var lastClusterId = -1, mergedPoints = new Map();
		clusteredStops.features.forEach((stop, i) => {
			if(stop.properties.cluster > lastClusterId) {
				lastClusterId = stop.properties.cluster;
				const pointsInCluster = clusteredStops.features.filter(s => s.properties.cluster == stop.properties.cluster);
				const turfPoints = turf.points(pointsInCluster.map(p => p.geometry.coordinates));
				var mergedPoint = turf.center(turfPoints, {properties:{cluster:lastClusterId,
					refclusters: pointsInCluster.reduce((prev, curr ) => {curr.properties.refclusters.forEach(c => prev.add(c)); return prev; }, new Set())
					}});
				mergedPoints.set(lastClusterId, mergedPoint);
			}
		});
		bridgeStops = [];
		mergedPoints.forEach(p => {
			bridgeStops[p.properties.cluster] = {
				lat: p.geometry.coordinates[1],
				lon: p.geometry.coordinates[0],
				neighbours: Array.from(p.properties.refclusters.values())
			};
		});
		bridgeStopPolys = turf.featureCollection(Array.from(mergedPoints.values()));
		bridgeStopPolys = bridgeStopPolys.features.map(stop => turf.circle(stop.geometry.coordinates, 0.01, {steps: 4, units: 'kilometers'}));
		console.log('bridgeStops', oldStopCount, bridgeStops.length, bridgeStops);
	}
	
	return {lands:lands, bridgeLand:bridgeMultiPoly, bridgeEndpoints:bridgeStops, bridgeStopPolys:bridgeStopPolys};
}

function AddBridgesToRoutes(bridges, gtfsRoutes)
{
	if('bridgeLand') {
		bridges.lands.push(bridges.bridgeLand);
	}
	clusterStops(gtfsRoutes.stops, bridges.lands);
	gtfsRoutes.lands = bridges.lands;

	if('bridgeLand' in bridges && 'bridgeEndpoints' in bridges) {
		AddBridgesToStops(bridges, gtfsRoutes.stops);
	}
}

function AddBridgesToStops(bridges, stops)
{
	console.log('bridgeEndpoints',bridges.bridgeEndpoints);
	var bridgeStops = bridges.bridgeEndpoints;

	clusterStops(bridgeStops, bridges.lands);

	var mergedBridgeStops = [];

	bridgeStops.forEach(bs => {
		for(var si=0; si<stops.length; si++) {
			const stop = stops[si];
			const notBridgeLandsMask = ~(BigInt(1)<<BigInt(bridges.lands.length-1));
			if((stop.lands & notBridgeLandsMask) != (bs.lands & notBridgeLandsMask)) continue;
			const distSqr = sqr((stop.lon-bs.lon)*71.6) + sqr((stop.lat-bs.lat)*111.3);
			if(distSqr < 0.05*0.05) {
				bs.mergeTo = si;
				break;
			}
		}
	});
		
	bridgeStops.forEach(bs => {
		bs.neighbours = bs.neighbours.map(nInd => {
			const neighbour = ('mergeTo' in bridgeStops[nInd]) ? stops[bridgeStops[nInd]['mergeTo']] : bridgeStops[nInd]
			return {stop:neighbour, dist:Math.sqrt(sqr((neighbour.lon-bs.lon)*71.6) + sqr((neighbour.lat-bs.lat)*111.3))};
			});
		bs.name = 'Híd';
		bs.trips = [];
	});

	console.log('bridgestops before merge:', bridgeStops.length);
	bridgeStops = bridgeStops.filter(bs => !('mergeTo' in bs));
	console.log('bridgestops after merge:', bridgeStops.length);

	bridgeStops.forEach(bs => {
		var mediumRange = [];
		stops.forEach(stop => {
			if(!(stop.lands & bs.lands)) return;
			const distSqr = sqr((stop.lon-bs.lon)*71.6) + sqr((stop.lat-bs.lat)*111.3);
			if(distSqr < 0.3*0.3) {
				const dist = Math.sqrt(distSqr);
				stop.neighbours.push({stop:bs, dist:dist});
				bs.neighbours.push({stop:stop, dist:dist});
			} else if(distSqr < 1*1) {
				mediumRange.push({stop:stop, dist:distSqr});
			}
		});
		/*if(bs.neighbours.length < 5) {
			mediumRange.forEach(ns => {
				ns.dist = Math.sqrt(ns.dist);
				bs.neighbours.push(ns);
				ns.stop.neighbours.push({stop:bs, dist:ns.dist});
			});
		}*/
	});
	console.log('bridgeEndpoints with neighbours',bridges.bridgeEndpoints);
	stops.push(...bridgeStops);
}