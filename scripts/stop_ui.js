
class StopDrawUI {
  constructor(map) {
	var thisref = this;
    this.map = map;
	this.minZoom = 14.5;
	this.debugCells = false;
	this.debugBox = false;
	
	this.collectingStops = false;
	this.repeatAreaQueryTask = false;
	this.nextAreaQueryTime = 0;
	this.wrappedQueryAreaInfo = function(){thisref.queryAreaInfo.call(thisref);};
	this.areaQueryTimeout = null;
	this.registeredEventHandlers = [];
	
	this.ununsedStopMarkers = [];
	this.stopMarkersByCells = new Map();
	this.hiddenCells = new Set();
	
	this.registerMapEventHandler('move', function(e){
		thisref.onMapMove.call(thisref, e);
	});
  }
  registerMapEventHandler(eventName, eventHandler) {
	this.registeredEventHandlers.push(eventName, eventHandler);
	this.map.on(eventName, eventHandler);
  }
  unregisterMapEventHandlers() {
	for(const [eventName, eventHandler] of this.registeredEventHandlers) {
		this.map.off(eventName, eventHandler);
	}
  }
  onMapMove(e) {
	if(this.map.getZoom() > this.minZoom) {
		this.showAllStops();
		this.queryAreaInfo();
	} else {
		this.hideAllStops();
	}
  }
  queryAreaInfo() {
	const now = Date.now();
	if(now < this.nextAreaQueryTime) {
		if(this.areaQueryTimeout) {return;}
		this.areaQueryTimeout = setTimeout(this.wrappedQueryAreaInfo, this.nextAreaQueryTime - now);
		return;
	}
	if(!this.collectingStops) {
		this.collectingStops = true;
		this.repeatAreaQueryTask = false;
		this.nextAreaQueryTime = now + 500;
		this.areaQueryTimeout = null;

		var bounds = this.map.getBounds();
		var line = turf.lineString([[bounds._sw.lng,bounds._sw.lat],[bounds._ne.lng,bounds._ne.lat]]);
		var bbox = turf.bbox(line);
		var bboxPolygon = turf.bboxPolygon(bbox);
		
		if(this.debugBox) {drawGeoJson(bboxPolygon);}
		
		mapUI.worker.postMessage({task:'s2bb', bb:bboxPolygon});
	} else {
		this.repeatAreaQueryTask = true;
	}
  }
  updateStops(areaInfo) {
	this.collectingStops = false;
	if(this.repeatAreaQueryTask) { this.queryAreaInfo(); }
	
	const showMarkers = this.map.getZoom() > this.minZoom;
	
	if('notNeededCells' in areaInfo) {
		for(const nCell of areaInfo.notNeededCells) {
			this.setStopsUnusedInCellKey(nCell);
		}
	}
	for(const [cellKey, cell] of areaInfo.cells) {
		if('stops' in cell) {
			if(this.stopMarkersByCells.has(cellKey)) continue;
			
			var markers = [];
			for(const stop of cell.stops) {
				var marker;
				if(this.ununsedStopMarkers.length==0) {
					var markerElement = document.createElement('div');
					markerElement.setAttribute('style', 'width:30px; height:30px;');
					var svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
					svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
					svgElement.setAttribute('viewBox', '0 0 10 10');
					svgElement.setAttribute('style', 'overflow: visible;"');
					svgElement.innerHTML = '<circle cx="5" cy="5" r="2.9" fill="black"/><circle cx="5" cy="5" r="1.7" fill="white"/>';
					markerElement.appendChild(svgElement);
					marker = new maplibregl.Marker({
						element: markerElement
					});
				} else {
					marker = this.ununsedStopMarkers.pop();
				}
				marker.setLngLat(stop);
				if(showMarkers) marker.addTo(this.map);
				
				markers.push(marker);
			}
			this.stopMarkersByCells.set(cellKey, markers);
			if(!showMarkers) {this.hiddenCells.add(cellKey);}
		}
	}
	
	if(this.debugCells) {drawGeoJson(areaInfo.multipolygon);}
  }
  setStopsUnusedInCellKey(cellKey) {
	const cell = this.stopMarkersByCells.get(cellKey);
	if(cell) {
		for(const marker of cell) {
			marker.remove();
			this.ununsedStopMarkers.push(marker);
		}
		this.stopMarkersByCells.delete(cellKey);
		this.hiddenCells.delete(cellKey);
	}
  }
  hideStopsInCellKey(cellKey) {
	if(this.hiddenCells.has(cellKey)){return;}
	const cell = this.stopMarkersByCells.get(cellKey);
	if(cell) {
		for(const marker of cell) {
			marker.remove();
		}
	}
	this.hiddenCells.add(cellKey);
  }
  hideAllStops() {
	  if(this.stopMarkersByCells.size == 0){return;}
	  for(const cellKey of this.stopMarkersByCells.keys()) {
		  this.hideStopsInCellKey(cellKey);
	  }
  }
  showAllStops() {
	  for(const cellKey of this.hiddenCells.values()) {
		  for(const marker of this.stopMarkersByCells.get(cellKey)) {
			  marker.addTo(this.map);
		  }
		  this.hiddenCells = new Set();
	  }
  }
}
