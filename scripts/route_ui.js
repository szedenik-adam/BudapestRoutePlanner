
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
  
  addMarker(options)
  {
	var markerElement = document.createElement('div');
	markerElement.setAttribute('style', 'width:20px; height:20px');
	var svgElement = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
	svgElement.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
	svgElement.setAttribute('viewBox', '0 0 10 10');
	svgElement.setAttribute('style', 'overflow: visible;"');
	if(options.destMarker)
		 svgElement.innerHTML = '<circle cx="5" cy="5" r="5" fill="white"/><circle cx="5" cy="5" r="4.9" fill="black"/><circle cx="5" cy="5" r="3.7" fill="white"/><circle cx="5" cy="5" r="2" fill="black"/>';
	else svgElement.innerHTML = '<circle cx="5" cy="5" r="5" fill="white"/><circle cx="5" cy="5" r="4.9" fill="black"/><circle cx="5" cy="5" r="3.7" fill="white"/>';
	svgElement.innerHTML += '<g class="timeG" visibility="hidden">\
	<rect x="-5" y="10" width="20" height="8" rx="4" ry="4" stroke="black" stroke-width="1" fill="white"></rect>\
	<text x="50%" y="14" dominant-baseline="middle" text-anchor="middle" font-weight="bold" font-size="0.5em" font-family="Calibri, sans-serif" class="timeText">00:00</text>\
	</g>';
	markerElement.appendChild(svgElement);
	markerElement.style.visibility = ('visible' in options && !options.visible) ? 'hidden' : 'visible';
	const marker = new maplibregl.Marker({
		element: markerElement,
		draggable: true
	}).setLngLat(options.lngLat).addTo(map);
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
	if(options.destMarker) this.rDestinationMarker = marker; else this.rSourceMarker = marker;
	console.log('added marker', marker);
	return marker;
  }
  
  _addMarkerOnClickEventHandler(e)
  {
	const destMarker = (this.rSourceMarker != null || (Date.now()-this.userLocationTime)<5200);
	const cElem = document.getElementById("coordinates");
	cElem.innerHTML = e.lngLat.lat + ', ' + e.lngLat.lng;
	
	if(destMarker && this.rDestinationMarker != null) {
		this.rDestinationMarker.setLngLat(e.lngLat);
		this.addRouteTask();
		return;
	}
	
	this.addMarker({destMarker:destMarker, lngLat:e.lngLat});
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
  
  updateUserLocation(lngLat)
  {
	  this.userLocation = lngLat;
	  this.userLocationTime = Date.now();

	  if(this.rSourceMarker == null) {
		  this.addMarker({destMarker:false, lngLat:lngLat, visible:true});
	  } else {
		  this.rSourceMarker.setLngLat(lngLat);
	  }
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
	beginStopAdd() {
		this.stopInd = -1;
	}
	addStop(pos) {
		this.stopInd++;
		if (this.stopInd < this.stopMarkers.length) {
			this.stopMarkers[this.stopInd]._element.style.visibility = "visible";
			const oldPos = this.stopMarkers[this.stopInd].getLngLat();
			if (oldPos.lng == pos[0] && oldPos.lat == pos[1]) {
				return;
			}
			this.stopMarkers[this.stopInd].setLngLat(pos);
			return;
		}
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
	endStopAdd() {
		for(var i = this.stopInd+1; i < this.stopMarkers.length; i++) {
			this.stopMarkers[i]._element.style.visibility = "hidden";
		}
	}
	drawRoute(route) {
		if(this.mapUI.rSourceMarker) this.mapUI.rSourceMarker.setTime(route[0].t[0]);
		if(this.mapUI.rDestinationMarker) this.mapUI.rDestinationMarker.setTime(route.at(-1).t[1]);
		
		this.clearFeatures();
		for(const part of route) this.addFeatureWithBorder(part.p, {'color':part.c});
		this.commitChanges();
		
		this.beginStopAdd();
		var lastStopPos = [0,0];
		for(const part of route) {
			for(const stop of part.s) {
				if(stop[0]!=lastStopPos[0] || stop[1]!=lastStopPos[1]) {
					this.addStop(stop);
					lastStopPos = stop;
				}
			}
		}
		this.endStopAdd();
	}
	clear() {
		this.clearFeatures();
		this.commitChanges();
		this.beginStopAdd();
		this.endStopAdd();
	}
}

class ProgressBar {
	constructor () {}
	show(){document.getElementById("progressBarContainer").classList.remove("hidden"); return this;}
	hide(){document.getElementById("progressBarContainer").classList.add("hidden"); return this;}
	isVisible(){return !document.getElementById("progressBarContainer").classList.contains("hidden"); return this;}
	setTitle(title){document.getElementById("progressTitle").textContent=title; return this;}
	setProgress(progress){document.getElementById("progressBar").value=progress*100; return this;}
}
const fmtTimeMode = {
	default: 0,
	withSeconds: 1,
	hourOptional: 2,
}
function fmtTime(t, options = fmtTimeMode.default) { // also defined in gtfs.js (todo: move to common file!)
	var sign='';
	if(t<0){t*=-1; sign='-';}
	
	t = t % 86400;
	var s = (t % 60).toFixed(0);
	t = Math.floor(t/60);
	var m = (t % 60).toFixed(0);
	t = Math.floor(t/60);
	var h = (t % 24).toFixed(0);
	const writeHours = t || !(options&fmtTimeMode.hourOptional);
	return sign+(writeHours?(h+':'+('00'+m).slice(-2)):m)+((options&fmtTimeMode.withSeconds)?(':'+('00'+s).slice(-2)):(''))
}
function showRoute(steps)
{
	const panel = document.getElementById('routeInfoContainer');

	const leftHeadline = panel.getElementsByTagName("h1")[0];
	const rightHeadline = panel.getElementsByClassName('rightHeadline')[0];
	var start = steps[0].start;
	if(steps.length > 1 && steps[1].task=='wait') { start += steps[1].duration; }
	const end = steps.at(-1).end;
	leftHeadline.textContent = `${fmtTime(start)} - ${fmtTime(end)}`;
	rightHeadline.textContent = `${Math.ceil((end-steps[0].start)/60)} minutes`;

	const routeHolder = panel.getElementsByClassName('route')[0];
	var routeContent = '';
	var firstElement = true, lastTask = '';
	for(const step of steps) {
		if('task' in step && step.task == 'wait') { continue; }
		if('task' in step && step.task == 'walk' && lastTask == 'walk') { continue; }

		if(!firstElement) {
			routeContent += '<span><span class="nextSymbol"></span></span>';
		} else { firstElement = false; }

		if('routeName' in step) {
			lastTask = step.routeName;
			var altRoutes = '';
			if('altRoutes' in step) {
				altRoutes = [];
				for(const altRoute of step.altRoutes) {
					const style = 'style="background-color:#'+altRoute[1][0]+';color:#'+altRoute[1][1]+'"';
					altRoutes.push(`<span ${style}><span>${altRoute[0]}</span></span>`);
				}
				altRoutes = altRoutes.join(' ');
			}
			const style = 'color' in step ? 'style="background-color:#'+step.color[0]+';color:#'+step.color[1]+'"' : '';
			routeContent += `<span class="hsList"> <span ${style}><span>${step.routeName}</span></span> ${altRoutes}</span>`;
		}
		else if('task' in step) {
			lastTask = step.task;
			if(step.task == 'walk') {
				routeContent += '<span><span class="walkSymbol"></span></span>';
			}
		}
	}
	routeHolder.innerHTML = routeContent;
	
	const detailedInfoHolder = panel.getElementsByClassName('details')[0];
	detailedInfoHolder.innerHTML = createDetailedRouteInfo(steps);
}

function createDetailedRouteInfo(steps)
{
	const walkSpeed = 5/3600;
	var htmlRows = [];
	var lastStop = '';
	for(const [si, step] of steps.entries()) {
		if('task' in step && step.task == 'wait') { continue; }
		if('task' in step && step.task == 'walk') {
			const waitTime = (si+1 < steps.length && 'task' in steps[si+1] && steps[si+1].task == 'wait') ? steps[si+1].duration : 0;
			const walkTime = step.duration;
			const distanceKm = turf.distance(turf.point(step.points[0]), turf.point(step.points[1]));
			const distanceM = Math.ceil(distanceKm*1000);
			const pacePercent = Math.round(100*(distanceKm/walkSpeed) / (walkTime+waitTime));
			
			const waitCellContent = waitTime ? `<span class="waitSymbol"></span><span>${fmtTime(waitTime, fmtTimeMode.withSeconds|fmtTimeMode.hourOptional)}</span>` :'';
			htmlRows.push(`<tr>
							<td style="line-height:0px" class="vehicle"><span class="walkSymbol"></span></td>
							<td class="time"><span>${fmtTime(walkTime, fmtTimeMode.withSeconds|fmtTimeMode.hourOptional)}</span></td>
							<td class="distance"><span>${distanceM}m</span></td>
							<td class="speed"><span class="gaugeSymbol"></span><span>${pacePercent}%</span></td>
							<td class="vehicle">${waitCellContent}</td>
						  </tr>`);
		}
		if('routeName' in step) {
			const delay = ('delay' in step) ? step.delay : 0;
			const delayCellContent = delay ? `<span class="delaySymbol"></span><span>${fmtTime(delay, fmtTimeMode.withSeconds|fmtTimeMode.hourOptional)}</span>` : '';
			htmlRows.push(`<tr class="internal">
							<td rowspan="2" class="vehicle"><span class="hsList"> <span style="background-color:#${step.color[0]};color:#${step.color[1]}"><span>${step.routeName}</span></span> </span></td>
							<td class="time"><span>${fmtTime(step.start, fmtTimeMode.withSeconds)}</span></td>
							<td colspan="2">${lastStop}</td>
							<td class="vehicle">${delayCellContent}</td>
						</tr>
						<tr>
							<td><span>${fmtTime(step.end, fmtTimeMode.withSeconds)}</span></td>
							<td colspan="2">${step.dstStop}</td>
						</tr>`);
		}
		if('dstStop' in step){ lastStop = step.dstStop; }
	}
	const table = '<table>'+htmlRows.join('')+'</table>';
	return table;
}
