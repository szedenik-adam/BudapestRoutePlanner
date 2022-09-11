
class RouteUI {
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
	  	    for(const func of funcs) func.call(this);
	  	  }
			
		  if (this.onStyleLoaded.length > 0) {
	  	    this.onStyleLoadTimer = setTimeout(styleLoadCheck, 200);
		  }
	    };
	    styleLoadCheck();
	  });
	}
  }
  
  _addMarkerOnClickEventHandler(e)
  {
	const cElem = document.getElementById("coordinates");
	cElem.innerHTML = e.lngLat.lat + ', ' + e.lngLat.lng;
	
	var markerElement = document.createElement('div');
	markerElement.setAttribute('style', 'width:20px; height:20px');
	var svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svgElement.setAttribute('viewBox', '0 0 10 10');
	svgElement.innerHTML = '<circle cx="5" cy="5" r="5" fill="white"/><circle cx="5" cy="5" r="4.9" fill="black"/><circle cx="5" cy="5" r="3.7" fill="white"/><circle cx="5" cy="5" r="2" fill="black"/>';
	markerElement.appendChild(svgElement);
	const marker = new maplibregl.Marker({
		element: markerElement,
		draggable: true
	}).setLngLat(e.lngLat).addTo(map);
	marker.getElement().addEventListener('click', (e) => {
		console.log('marker clicked', e);
		e.stopPropagation();
	});
	marker.on('dragend', (e) => {
		console.log('marker dragend', e);
	});
  }

  addMarkerOnClick(enable=true)
  {
	if(enable) this.map.on('click', this._addMarkerOnClickEventHandler);
	else this.map.off('click', this._addMarkerOnClickEventHandler);
  }
  
  addLinesTest()
  {
	if(!this.styleLoaded){ this.onStyleLoaded.push(this.addLinesTest); return;}

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
			'properties': {'color':'#00ff00'},
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
	const source = map.getSource('customLines');
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
			'line-color': ['get', 'color'],
			'line-width': 8
			}
		});
  }
}
