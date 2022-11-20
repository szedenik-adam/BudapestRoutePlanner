
function S2_PointToCell(p, level=11, extendedResult=false, geoJsonResult=true)
{
	const keys = S2.latLngToNeighborKeys(p[0], p[1], level);
	var neighbourCenters = keys.map(key => S2.keyToLatLng(key));
	var cell = Array(4);
	for(var j=0;j<3;j++) {
		cell[j] = [(neighbourCenters[j].lat+neighbourCenters[j+1].lat)/2, (neighbourCenters[j].lng+neighbourCenters[j+1].lng)/2];
	}
	cell[3] = [(neighbourCenters[3].lat+neighbourCenters[0].lat)/2, (neighbourCenters[3].lng+neighbourCenters[0].lng)/2];
	if(geoJsonResult) {
		cell.push(cell[0]);
		cell = turf.polygon([cell]);
	}
	return (extendedResult) ? [cell, keys, neighbourCenters] : cell;
}

// https://github.com/google/s2geometry/blob/0e7b146184fbf119e60ceaf176c2b580c9d2cef4/src/s2/s2region_coverer.cc
function S2_CoverPolygon(polygon, level=12)
{
	const startPoint = turf.center(polygon);
	const startKey = S2.latLngToKey(startPoint.geometry.coordinates[0], startPoint.geometry.coordinates[1], level);
	
	var cells = new Map();
	var frontier = [[startKey, startPoint.geometry.coordinates]];
	var checkedKeys = new Set([startKey]);
	
	while (frontier.length) {
		const [key, point] = frontier.shift();
		const [cell, neighbourKeys, neighbourCenters] = S2_PointToCell(point, level, true);
		
		if (!turf.booleanIntersects(polygon, cell)) continue;
		
		cells.set(key, cell);
		
		for(var i=0; i<4; i++) {
			if(!checkedKeys.has(neighbourKeys[i])) {
				checkedKeys.add(neighbourKeys[i]);
				frontier.push([neighbourKeys[i], [neighbourCenters[i].lat,neighbourCenters[i].lng]]);
			}
		}
		//if(cells.size > 12) break;
	}
	return cells;
}

