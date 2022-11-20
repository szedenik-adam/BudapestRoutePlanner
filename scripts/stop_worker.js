
class StopInfoProvider {
	constructor(stops, s2level){
		this.lastSentCells=new Set();
		this.s2level=s2level;
		this.stops = new Map();
		for(const stop of stops) {
			if(stop.trips.length == 0) continue;
			const stopEntry = [stop.lon, stop.lat];
			const cellKey = S2.latLngToKey(stop.lon, stop.lat, s2level);
			var cellStops = this.stops.get(cellKey);
			if(cellStops === undefined) {
				this.stops.set(cellKey, [stopEntry]);
			} else {
				cellStops.push(stopEntry);
			}
		}
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
}