
class Realtime {
	constructor () {
		this.vehicleInterval = null;
		this.vehicleReading = false;
		this.tripMap = {};
		this.lastVehicleUpdate = 0;
		this.apikey = '';
		this.vehiclePollingPaused = false;

		fetch('https://bprp.pages.dev/realtime.txt')
		.then((response) => {
			if (!response.ok) { throw new Error('Failed to get realtime api key!'); }
			return response.text();
		})
		.then((apikey) => {
			this.apikey = apikey;
			this.startVehiclePolling();
		})
		.catch((error) => {
			console.error('Realtime api key fetch operation failed:', error);
		});
		
		document.addEventListener("visibilitychange", () => {
		  if (document.hidden) {
			  if (this.vehicleInterval) {
				this.stopVehiclePolling(true);
			  }
		  } else {
			  if (this.vehiclePollingPaused) {
				this.startVehiclePolling();
			  }
		  }
		});
	}
	
	async update(url) {
		const response = await fetch(url, {});
		const responseBuff = await response.arrayBuffer();
		const messageObj = $root.transit_realtime.FeedMessage;
		return messageObj.decode(new Uint8Array(responseBuff));
	}
	
	async updateVehicle(url) {
		this.lastVehicleUpdate = Date.now();
		const vehiclePromise = this.update(url);
		var vehicles = await vehiclePromise;
		this.vehiclesFromUrl = vehicles;
		vehicles = await workerPromises.processTask({task:'gtfs-rt',vehicles:vehicles});
		vehicles = vehicles.vehicles;
		this.vehicles = vehicles;
		if(realtimeUI && realtimeUI.ready) {
			realtimeUI.drawVehicles(vehicles);
		}
	}
	startVehiclePolling() {
		this.vehiclePollingPaused = false;
		if(!this.vehicleInterval) {
			if(Date.now() - this.lastVehicleUpdate > 10000) {
				this.pollVehicle();
			}
			this.vehicleInterval = setInterval(this.pollVehicle.bind(this), 10000);
		}
	}
	stopVehiclePolling(isPaused) {
		this.vehiclePollingPaused = isPaused;
		if(this.vehicleInterval) {
			clearInterval(this.vehicleInterval);
			this.vehicleInterval = null;
		}
	}
	pollVehicle() {
		if(this.vehicleReading) {this.vehicleReading=false; return;}
		this.vehicleReading = true;
		this.updateVehicle('https://go.bkk.hu/api/query/v1/ws/gtfs-rt/full/VehiclePositions.pb?key='+this.apikey).then((result) => {
			this.vehicleReading = false;
		});
	}
}

class RealtimeUI {
	constructor(mapUI) {
		this.mapUI = mapUI;
		this.mapUI.callAfterMapStyleLoaded(this, this.initSourceAndLayer);
		this.vehicleTypeMap = new Map();
		this.vehicleTypeMap.set(0, 'tram');
		this.vehicleTypeMap.set(2, 'rail');
		this.vehicleTypeMap.set(3, 'bus');
		this.vehicleTypeMap.set(11, 'trolley');
		this.vehicleTypeMap.set(109, 'suburban_rail');
		this.ready = false;
		// use the following code to find unknown vehicle types:
		// oo={}; realtime.vehicles.entity.forEach(e => {if(e.vehicle.vehicle[".realcity.vehicle"].vehicle_model) oo[e.vehicle.vehicle[".realcity.vehicle"].vehicle_type] = e.vehicle.vehicle[".realcity.vehicle"].vehicle_model}); oo 
	}
	initSourceAndLayer() {
		this.mapUI.map.addSource('vehicles', {
			'type': 'geojson',
			'data': {
				'type': 'FeatureCollection',
				'features': [ ]
			}
		});
		this.mapUI.map.addLayer({
			'id': 'vehicleDirs',
			'type': 'symbol',
			'source': 'vehicles',
			'layout': {
				'icon-image': 'varrow',
				'icon-size': ['interpolate',['linear'],['zoom'], 10,0.05, 15,0.43],
				'icon-rotate': ['get', 'bearing'],
				'icon-rotation-alignment': 'map',
				"icon-ignore-placement": true,
				"icon-allow-overlap": true,
			},
			'filter': ['has', 'bearing'],
			'minzoom': 12
		});
		this.mapUI.map.addLayer({
			'id': 'vehicles',
			'type': 'symbol',
			'source': 'vehicles',
			'layout': {
				'icon-image': ['string', ['get', 'icon'], 'bus'],
				'icon-size': ['interpolate',['linear'],['zoom'], 10,0.05, 15,0.3],
				'icon-rotation-alignment': 'map',
				"icon-ignore-placement": true,
				"icon-allow-overlap": true,
				
				'text-field': ['string', ['get', 'label'], 'null'],
				'text-font': ['Open Sans Regular'],
				'text-offset': [1.2, 0],
				"text-size": {
					"stops": [ [0, 0], [14, 0], [14.4, 14] ]
				},
				'text-anchor': 'left',
				'text-allow-overlap': true,
				'text-ignore-placement':true,
				'text-optional':true,
			},
			'paint': {
			  "text-color": "#000000",
			}
		});
		this.ready = true;
		if('vehicles' in realtime){this.drawVehicles(realtime.vehicles);}
	}
	drawVehicles(vehicles) {
		var vpoints = [];
		vehicles.entity.forEach(e => {
			vpoints.push(turf.point([e.vehicle.position.longitude, e.vehicle.position.latitude], 
				{
					label: e.vehicle.vehicle.label,
					bearing: e.vehicle.position.bearing,
					icon: this.vehicleTypeMap.get(e.vehicle.vehicle[".realcity.vehicle"].vehicle_type)??'bus_station'
				}
			));
		});
		var source = this.mapUI.map.getSource('vehicles');
		if(source) {
			vpoints = turf.featureCollection(vpoints);
			source.setData(vpoints);
		}
	}
}