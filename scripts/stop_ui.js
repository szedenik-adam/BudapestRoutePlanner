
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
				var marker, svgElement;
				if(this.ununsedStopMarkers.length==0) {
					var markerElement = document.createElement('div');
					markerElement.setAttribute('style', 'width:30px; height:30px;');
					var svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
					svgElement.setAttribute('onclick', "stopDrawUI.markerClick(this, event)");
					svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
					svgElement.setAttribute('viewBox', '0 0 10 10');
					svgElement.setAttribute('style', 'overflow: visible;"');
					
					markerElement.appendChild(svgElement);
					marker = new maplibregl.Marker({
						element: markerElement
					});
				} else {
					marker = this.ununsedStopMarkers.pop();
					svgElement = marker.getElement().children[0];
				}
				
				svgElement.innerHTML = '<circle cx="5" cy="5" r="3.2" fill="black"/>';
				if(stop[3]!=null) svgElement.innerHTML += '<polygon points="2.2,4 7.8,4 5,0" fill="black" transform="rotate('+stop[3]+' 5 5)" />';
				const arcs = drawColoredCircle({cX:5,cY:5,r:2.9,colors:stop[2].map(color=>'#'+color)});
				svgElement.appendChild(arcs);
				svgElement.innerHTML += '<circle cx="5" cy="5" r="1.7" fill="white" stroke="black" stroke-width="0.3"/>';
				svgElement.dataset.stopId = 11;
				
				marker.setLngLat(stop.slice(0,2));
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
  markerClick(div, event) {
	  console.log('stop marker click', this, div, event, div.dataset.stopId);
	  event.stopPropagation();
  }
}


function drawPieSlice(settings)
{
    let d = "";

    const firstCircumferenceX = settings.cX + settings.r * Math.cos(settings.startAngleRad);
    const firstCircumferenceY = settings.cY + settings.r * Math.sin(settings.startAngleRad);
    const secondCircumferenceX = settings.cX + settings.r * Math.cos(settings.startAngleRad + settings.sweepAngleRad);
    const secondCircumferenceY = settings.cY + settings.r * Math.sin(settings.startAngleRad + settings.sweepAngleRad);

    // move to centre
    d += "M" + settings.cX + "," + settings.cY + " ";
    // line to first edge
    d += "L" + firstCircumferenceX + "," + firstCircumferenceY + " ";
    // arc
    // Radius X, Radius Y, X Axis Rotation, Large Arc Flag, Sweep Flag, End X, End Y
    d += "A" + settings.r + "," + settings.r + " 0 0,1 " + secondCircumferenceX + "," + secondCircumferenceY + " ";
    // close path
    d += "Z";

    const arc = document.createElementNS("http://www.w3.org/2000/svg", "path");
    arc.setAttributeNS(null, "d", d);
    arc.setAttributeNS(null, "fill", settings.fillColor);
    //arc.setAttributeNS(null, "style", "stroke:" + settings.strokeColor + ";");

	return arc;
    //document.getElementById(settings.id).appendChild(arc);
}

function drawColoredCircle(settings)
{
	if(settings.colors.length == 1) {
		const circle = document.createElementNS("http://www.w3.org/2000/svg", "circle");
		circle.setAttributeNS(null, "cx", settings.cX);
		circle.setAttributeNS(null, "cy", settings.cY);
		circle.setAttributeNS(null, "r", settings.r);
		circle.setAttributeNS(null, "fill", settings.colors[0]);
		return circle;
	}
	var arcs = new DocumentFragment()
	settings.sweepAngleRad = Math.PI*2/settings.colors.length;
	settings.startAngleRad = -Math.PI/2;
	for(const color of settings.colors) {
		settings.fillColor = color;
		const arc = drawPieSlice(settings);
		arcs.appendChild(arc);
		settings.startAngleRad += Math.PI*2/settings.colors.length;
	}
	return arcs;
}