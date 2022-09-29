
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
	if(destMarker)
		 svgElement.innerHTML = '<circle cx="5" cy="5" r="5" fill="white"/><circle cx="5" cy="5" r="4.9" fill="black"/><circle cx="5" cy="5" r="3.7" fill="white"/><circle cx="5" cy="5" r="2" fill="black"/>';
	else svgElement.innerHTML = '<circle cx="5" cy="5" r="5" fill="white"/><circle cx="5" cy="5" r="4.9" fill="black"/><circle cx="5" cy="5" r="3.7" fill="white"/>';
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
			'line-width': ['number', ['get', 'width'], 8],
			'line-blur': 0.5
			}
		});
		this.source = this.mapUI.map.getSource('routeSource');
		this.layer = map.getLayer('routeLayer');
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
	clearFeatures() {
		this.source._data.features = [];
	}
	commitChanges() {
		// might need to be called after style is loaded like:
		//this.mapUI.callAfterMapStyleLoaded(this, function(){this.source.setData(this.source._data)});
		this.source.setData(this.source._data);
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
