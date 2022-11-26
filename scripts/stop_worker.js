
class StopInfoProvider {
	constructor(stops, s2level){
		this.lastSentCells=new Set();
		this.s2level=s2level;
		this.stops = new Map();
		stops.forEach((stop,stopInd) => {
			if(stop.trips.length == 0) return;
			var colors = new Set(); for(var ti=0;ti<stop.trips.length;ti++){ colors.add(stop.trips[ti][0].route.color[0]); }
			const stopEntry = [stop.lon, stop.lat, Array.from(colors), stop.dir, stopInd];
			const cellKey = S2.latLngToKey(stop.lon, stop.lat, s2level);
			var cellStops = this.stops.get(cellKey);
			if(cellStops === undefined) {
				this.stops.set(cellKey, [stopEntry]);
			} else {
				cellStops.push(stopEntry);
			}
		});
	}
	getStopsForArea(polygon){
		if(polygon == null) {
			this.lastSentCells = new Set();
			return {cells:this.lastSentCells, notNeededCells:this.lastSentCells};
		}
		var notNeededCells = new Set(this.lastSentCells);
		var cells = S2_CoverPolygon(polygon, this.s2level);
		var stopCount = 0;
		cells.forEach((cell, cellKey) => {
			if(this.lastSentCells.has(cellKey)) {
				notNeededCells.delete(cellKey);
			}
			else {
				cell.stops = this.stops.get(cellKey) ?? [];
				stopCount += cell.stops.length;
			}
		});
		this.lastSentCells = new Set(cells.keys());
		return {cells:cells, notNeededCells:notNeededCells};
	}
	getDetailedStopInfo(stop) {
		const now = getGtfsTime(Date.now(), gtfsRoutes);
		var departures = [];
		for(const [trip, stopIndOfTrip] of stop.trips) {
			const departureTime = trip.stopDep[stopIndOfTrip];
			if(departureTime < now) continue;
			departures.push([trip.route.name, trip.route.color, departureTime, trip.stops.at(-1).name]);
			//if(departures.length > 10) break; // add after stop trip sorted.
		}
		departures.sort((a, b) => a[2] > b[2]); // TODO: sort stop's trip list by departure times! (then remove this line)
		departures.splice(10);  // remove after stop trip sorted.
		departures.forEach(dep => dep[2] = gtfsTimeToDate(dep[2], gtfsRoutes)/1000);
		return {name:stop.name, departures:departures};
	}
}
