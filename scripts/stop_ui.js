
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
	
	this.clickedSvg = null;
	
	this.observer = new IntersectionObserver((entries, observer)=>thisref.handleIntersect(entries, observer), {root: null,rootMargin: "0px",threshold: 0});
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
					this.observer.observe(markerElement);
				} else {
					marker = this.ununsedStopMarkers.pop();
					svgElement = marker.getElement().children[0];
				}
				
				svgElement.innerHTML = '<circle cx="5" cy="5" r="3.2" fill="black"/>';
				if(stop[3]!=null) svgElement.innerHTML += '<polygon points="2.2,4 7.8,4 5,0" fill="black" transform="rotate('+stop[3]+' 5 5)" />';
				const arcs = drawColoredCircle({cX:5,cY:5,r:2.9,colors:stop[2].map(color=>'#'+color)});
				svgElement.appendChild(arcs);
				svgElement.innerHTML += '<circle cx="5" cy="5" r="1.7" fill="white" stroke="black" stroke-width="0.3"/>';
				svgElement.dataset.stopId = stop[4];
				
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
	  if(this.clickedSvg && this.clickedSvg.innerHTML.includes('animate')) {
		  this.clickedSvg.children[0].remove();
	  }
	  console.log('stop marker click', this, div, event, div.dataset.stopId);
	  event.stopPropagation();
	  this.clickedSvg = div;
	  mapUI.worker.postMessage({task:'stopInfo', stopId:div.dataset.stopId});
  }
  handleIntersect(entries, observer) {
	  //console.log('Intersect', entries, observer);
  }
  showStopDetailedInfo(stop) {
	  const div = document.getElementById('stopInfoContent');
	  div.children[0].textContent = stop.name;
	  div.parentNode.classList.remove('hidden');
	  console.log('clickedSvg',this.clickedSvg);
	  if(!this.clickedSvg.innerHTML.includes('animate')) {
		this.clickedSvg.innerHTML = 
		   `<circle cx="5" cy="5" r="3.2" fill="yellow">
		      <animate attributeName="r" calcMode="discrete" values="3.2;3.56;3.92;4.27;4.63;4.99;5.35;5.71;6.06;6.42;6.78;7.14;7.49;7.85;8.21;8.57;8.93;9.28;9.64;10" dur="1.5s" begin="0s" repeatCount="indefinite"/>
			  <animate attributeName="opacity" calcMode="discrete" values="1;0.96;0.92;0.87;0.83;0.79;0.75;0.71;0.66;0.62;0.58;0.54;0.49;0.45;0.41;0.37;0.33;0.28;0.24;0.2" dur="1.5s" begin="0s" repeatCount="indefinite"/>,
			</circle>` + this.clickedSvg.innerHTML;
		this.clickedSvg.querySelectorAll("animate").forEach((element) => { element.beginElement(); });
	  }
	  var depHtml = '';
	  for(const dep of stop.departures) {
			depHtml += `<a class="stopDepartureRow" style="color:${dep[4]?'green':'black'};">
				<span class="tripShortName" style="color: #${dep[1][1]}; background-color: #${dep[1][0]};">${dep[0]}</span>
				<span class="tripDepartureTime countdown" data-time="${dep[2]}">${dep[2]}</span>
				<span class="tripHeadsign">${dep[3]}</span>
			</a>`;
	  }
	  div.children[1].innerHTML = depHtml;
	  countdown.updateElements();
	  countdown.start();
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

class Countdown {
	constructor() {
		this.interval = null;
	}
	start() {
		if(this.interval==null) {
			this.interval = setInterval(this.updateElements.bind(this), 1000);
		}
	}
	updateElements() {
		const now = Date.now()/1000;
		const elems = document.getElementsByClassName('countdown');
		for (var i = 0; i < elems.length; i++) {
			const elem = elems[i];
			const time = parseInt(elems[i].dataset.time);
			const deltaSec = Math.floor(time-now);
			if(deltaSec > 0)
				elem.textContent = `${Math.floor(deltaSec/60)}:${(deltaSec % 60).toString().padStart(2,'0')}`;
			else elem.textContent = 'now';
		}
		if(elems.length == 0) {
			clearInterval(this.interval);
			this.interval = null;
		}
	}
}