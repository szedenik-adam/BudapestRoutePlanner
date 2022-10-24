
class MapUI {
  constructor(map) {
    this.map = map;
	
	this.styleLoaded = map.isStyleLoaded();
	this.onStyleLoaded = [];
	this.onStyleLoadTimer = null;
	if(!this.styleLoaded) {
	  map.on('styledata', () => {
	    if (this.onStyleLoadTimer) {
		  clearTimeout(this.onStyleLoadTimer);
		  this.onStyleLoadTimer = null;
		}
	    const styleLoadCheck = () => {
	  	  if (!map.isStyleLoaded()) {
	  	    console.log('waiting for style');
	  	  } else {
			this.styleLoaded = true;
	  	    console.log('style loaded', this.onStyleLoaded.length);
			const funcs = [...this.onStyleLoaded];
			this.onStyleLoaded = [];
	  	    for(const func of funcs) func[0].call(func[1]);
	  	  }
			
		  if (this.onStyleLoaded.length > 0) {
	  	    this.onStyleLoadTimer = setTimeout(styleLoadCheck, 200);
		  }
	    };
	    styleLoadCheck();
	  });
	}
	this.rSourceMarker = null;
	this.rDestinationMarker = null;
	this.boundAddMarkerOnClickEventHandler = this._addMarkerOnClickEventHandler.bind(this);
	this.geotracking = false;
	this.worker = null;
	this.routing = false;
	this.nextRouteTask = null;
  }
  
  _addMarkerOnClickEventHandler(e)
  {
	const destMarker = (this.rSourceMarker != null || this.geotracking);
	const cElem = document.getElementById("coordinates");
	cElem.innerHTML = e.lngLat.lat + ', ' + e.lngLat.lng;
	
	if(destMarker && this.rDestinationMarker != null) {
		this.rDestinationMarker.setLngLat(e.lngLat);
		this.addRouteTask();
		return;
	}
	
	var markerElement = document.createElement('div');
	markerElement.setAttribute('style', 'width:20px; height:20px');
	var svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svgElement.setAttribute('viewBox', '0 0 10 10');
	svgElement.setAttribute('style', 'overflow: visible;"');
	if(destMarker)
		 svgElement.innerHTML = '<circle cx="5" cy="5" r="5" fill="white"/><circle cx="5" cy="5" r="4.9" fill="black"/><circle cx="5" cy="5" r="3.7" fill="white"/><circle cx="5" cy="5" r="2" fill="black"/>';
	else svgElement.innerHTML = '<circle cx="5" cy="5" r="5" fill="white"/><circle cx="5" cy="5" r="4.9" fill="black"/><circle cx="5" cy="5" r="3.7" fill="white"/>';
	svgElement.innerHTML += '<g class="timeG" visibility="hidden">\
	<rect x="-5" y="10" width="20" height="8" rx="4" ry="4" stroke="black" stroke-width="1" fill="white"></rect>\
	<text x="50%" y="14" dominant-baseline="middle" text-anchor="middle" font-weight="bold" font-size="0.5em" font-family="Calibri, sans-serif" class="timeText">00:00</text>\
	</g>';
	markerElement.appendChild(svgElement);
	const marker = new maplibregl.Marker({
		element: markerElement,
		draggable: true
	}).setLngLat(e.lngLat).addTo(map);
	marker.getElement().addEventListener('click', (e) => {
		console.log('marker clicked', e);
		e.stopPropagation();
	});
	marker.on('drag', (e) => {
		this.addRouteTask();
	});
	marker.on('dragend', (e) => {
		this.addRouteTask();
	});
	marker.setTime = function(time) {
		const timeG = markerElement.getElementsByClassName('timeG');
		timeG[0].setAttribute('visibility', time ? 'visible' : 'hidden');
		if(!time) return;
		const timeT = markerElement.getElementsByClassName('timeText');
		timeT[0].innerHTML = time;
	}
	if(destMarker) this.rDestinationMarker = marker; else this.rSourceMarker = marker;
	this.addRouteTask();
  }

  addMarkerOnClick(enable=true)
  {
	if(enable) this.map.on('click', this.boundAddMarkerOnClickEventHandler);
	else this.map.off('click', this.boundAddMarkerOnClickEventHandler);
  }
  
  callAfterMapStyleLoaded(ctx, func)
  {
	if (!this.styleLoaded) { this.onStyleLoaded.push([func, ctx]); }
	else { func.call(ctx); }
  }
  
  tracking(isEnabled)
  {
	  this.geotracking = isEnabled;
	  console.log('geotracking', this.geotracking);
  }
  
  setWorker(worker)
  {
	  this.worker = worker;
  }
  
  addRouteTask()
  {
	  if(this.worker == null) return;
	  if(this.rDestinationMarker == null ||this.rSourceMarker == null) return;
	  const task = {src:this.rSourceMarker.getLngLat(),dst:this.rDestinationMarker.getLngLat()};
	  if(!this.routing) {
		  this.routing = true;
		  this.worker.postMessage(task);
	  } else {
		  this.nextRouteTask = task;
	  }
  }
  
  routeReceived()
  {
	  this.routing = false;
	  if(this.nextRouteTask) {
		  this.addRouteTask();
		  this.nextRouteTask = null;
	  }
  }
  
  addLinesTest() { this.callAfterMapStyleLoaded(this, this._addLinesTest); }
  
  _addLinesTest()
  {
	var geoJson = {
	  'type': 'geojson',
	  'data': {
		'type': 'FeatureCollection',
		'features': [
		  {
			'type': 'Feature',
			'properties': {'color':'red'},
			'geometry': {
			  'type': 'LineString',
			  'coordinates': [
				[19.05499444493165+Math.random()*0.0005-0.00025, 47.52649376411256+Math.random()*0.0005-0.00025],
				[19.063230222910875+Math.random()*0.0005-0.00025, 47.52454046418376+Math.random()*0.0005-0.00025],
				[19.06258690877337+Math.random()*0.0005-0.00025, 47.52289446901065+Math.random()*0.0005-0.00025], 
			  ]
			}
		  },
		  {
			'type': 'Feature',
			'properties': {'color':'#00ff00', 'width':20},
			'geometry': {
			  'type': 'LineString',
			  'coordinates': [
				[19.05809131631935, 47.523902263181526],
				[19.057243786593375, 47.52230969067739]
			  ]
			}
		  }
		]
	  }
    };
	const source = map.getSource('customLines'); console.log('source',source);
	if(!source) map.addSource('customLines', geoJson);
	else source.setData(geoJson.data);
	
	const layer = map.getLayer('lineTest');
	if (!layer)
		map.addLayer({
			'id': 'lineTest',
			'type': 'line',
			'source': 'customLines',
			'layout': {
			'line-join': 'round',
			'line-cap': 'round'
			},
			'paint': {
			'line-color': ['string', ['get', 'color'], 'gray'],
			'line-width': ['number', ['get', 'width'], 8],
			'line-blur': 0.5
			}
		});
  }
}

class Route {
	constructor (mapUI) {
		this.mapUI = mapUI;
		this.mapUI.callAfterMapStyleLoaded(this, this.initSourceAndLayer);
		this.source = null;
		this.layer = null;
		this.stopMarkers = [];
	}
	initSourceAndLayer() {
		var geoJson = {
		  'type': 'geojson',
		  'data': {
			  'type': 'FeatureCollection',
			  'features': []
		  }
		};
		this.mapUI.map.addSource('routeSource', geoJson);
		this.mapUI.map.addLayer({
			'id': 'routeLayer',
			'type': 'line',
			'source': 'routeSource',
			'layout': {
			'line-join': 'round',
			'line-cap': 'round'
			},
			'paint': {
			'line-color': ['string', ['get', 'color'], 'gray'],
			'line-width': ['number', ['get', 'width'], 6],
			'line-blur': 0.5
			}
		});
		this.source = this.mapUI.map.getSource('routeSource');
		this.layer = this.mapUI.map.getLayer('routeLayer');
	}
	addFeature(coords, properties={}) {
		var feature = {
			'type': 'Feature',
			'properties': properties,
			'geometry': {
				'type': 'LineString',
				'coordinates': coords
			}
		};
		this.source._data.features.push(feature);
	}
	addFeatureWithBorder(coords, properties={}) {
		var borderColor = 'black';
		if('color' in properties && properties.color.startsWith('#')) {
			borderColor = '#'+(Math.floor(parseInt(properties.color.substring(1,3),16)*0.5)).toString(16).padStart(2, '0')
			+(Math.floor(parseInt(properties.color.substring(3,5),16)*0.5)).toString(16).padStart(2, '0')
			+(Math.floor(parseInt(properties.color.substring(5,7),16)*0.5)).toString(16).padStart(2, '0');
		}
		var borderWidth = 9;
		if('width' in properties) { borderWidth = properties.width + 3; }
		
		this.addFeature(coords, {...properties, ...{'color':borderColor,'width':borderWidth}});
		this.addFeature(coords, properties);
	}
	clearFeatures() {
		this.source._data.features = [];
	}
	commitChanges() {
		// might need to be called after style is loaded like:
		//this.mapUI.callAfterMapStyleLoaded(this, function(){this.source.setData(this.source._data)});
		this.source.setData(this.source._data);
	}
	addStop(pos) {
		var markerElement = document.createElement('div');
		markerElement.setAttribute('style', 'width:20px; height:20px; pointer-events: none;');
		var svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
		svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
		svgElement.setAttribute('viewBox', '0 0 10 10');
		svgElement.setAttribute('style', 'overflow: visible;"');
		svgElement.innerHTML = '<circle cx="5" cy="5" r="3" fill="white"/><circle cx="5" cy="5" r="2.9" fill="black"/><circle cx="5" cy="5" r="1.7" fill="white"/>';
		//svgElement.innerHTML += '<rect x="-5" y="9" width="20" height="8" rx="4" ry="4" stroke="black" stroke-width="1" fill="white"></rect>'; 
		//svgElement.innerHTML += '<text x="50%" y="13" dominant-baseline="middle" text-anchor="middle" font-weight="bold" font-size="0.5em" font-family="Calibri, sans-serif" >00:00</text>';
		markerElement.appendChild(svgElement);
		const marker = new maplibregl.Marker({
			element: markerElement
		}).setLngLat(pos);
		
		this.stopMarkers.push(marker);
		marker.addTo(this.mapUI.map);
	}
	drawRoute(route) {
		if(this.mapUI.rSourceMarker) this.mapUI.rSourceMarker.setTime(route[0].t[0]);
		if(this.mapUI.rDestinationMarker) this.mapUI.rDestinationMarker.setTime(route.at(-1).t[1]);
		for(const stop of this.stopMarkers) stop.remove();
		
		this.clearFeatures();
		for(const part of route) this.addFeatureWithBorder(part.p, {'color':part.c});
		this.commitChanges();
		
		var lastStopPos = [0,0];
		for(const part of route) {
			for(const stop of part.s) {
				if(stop[0]!=lastStopPos[0] || stop[1]!=lastStopPos[1]) {
					this.addStop(stop);
					lastStopPos = stop;
				}
			}
		}
	}
}

class ProgressBar {
	constructor () {}
	show(){document.getElementById("bottomContainer").classList=[""];}
	hide(){document.getElementById("bottomContainer").classList=["hidden"];}
	isVisible(){return !document.getElementById("bottomContainer").classList.contains("hidden");}
	setTitle(title){document.getElementById("progressTitle").textContent=title;}
	setProgress(progress){document.getElementById("progressBar").value=progress*100;}
}
