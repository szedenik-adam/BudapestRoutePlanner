
class DestinationsUI {
	constructor(mapUI) {
		this.mapUI = mapUI;
		this.targets = {};
		this.dstsDiv = document.querySelector("#trackerContent .destinations");
		this.dstsDiv.innerHTML = '';
		this.calculatingRoute=false;
		this.source = null;
		this.layer = null;
		this.sourceData = {'type': 'FeatureCollection',	'features': [ ]};
		this.mapUI.callAfterMapStyleLoaded(this, this.initSourceAndLayer);
		this.scheduleRecalculation = false;
	}
	
	initSourceAndLayer() {
		this.mapUI.map.addSource('dstPolygon', {
			'type': 'geojson',
			'data': this.sourceData
		});
		this.source = this.mapUI.map.getSource('dstPolygon');

		this.mapUI.map.addLayer({
			"id": "dstPolygon",
			"type": "fill",
			"source": "dstPolygon",
			"layout": {},
			"paint": {
				"fill-color": "blue",
				"fill-opacity": 0.6
			}
		});
	}
	
	removeTargetById(targetId) {
		var row = document.getElementById('dst'+targetId);
		row.remove();
		this.sourceData.features = this.sourceData.features.filter(circle => {return circle.properties.id != targetId});
		if(this.source) this.source.setData(this.sourceData);
		delete this.targets[targetId];
	}
	
	removeTargetByElement(element) {
		var targetId = null;
		for(var i=0;i<10;i++) {
			if(element.id.startsWith('dst')) {targetId=element.id.substring(3); break;}
			element = element.parentElement;
		}
		if(targetId) {this.removeTargetById(targetId);}
	}
	
	isDuplicate(target) {
		for(const t of Object.values(this.targets)) {
			if(target.name == t.name && target.details == t.details && Math.floor(target.expiration.getTime()/1000) == Math.floor(t.expiration.getTime()/1000) && target.location[0] == t.location[0] && target.location[1] == t.location[1]) {
				return true;
			}
		}
		return false;
	}

	pushChanges(targets) {
		var changed = false;
		for(const [id, extTarget] of Object.entries(targets)) {
			if(this.isDuplicate(extTarget)){continue;}
			var target = this.targets[extTarget.id];
			if(target) {Object.assign(target, extTarget);}
			else {
				target = extTarget;
				this.targets[extTarget.id] = target;
				this.sourceData.features.push(turf.circle([target.location[1], target.location[0]], 0.04, {units: 'kilometers', properties: {id:target.id}}));
				console.log('sourceData', this.sourceData);
				if(this.source) this.source.setData(this.sourceData);
			}
			changed = true;
			console.log('pushChanges', target, extTarget);
			
			const targetRowContent = this.createTargetRowContent(target);

			const targetDiv = document.getElementById('dst'+target.id);
			if(targetDiv) { targetDiv.innerHTML = targetRowContent; }
			else {
				const newTargetDiv = document.createElement("div");
				newTargetDiv.setAttribute('id', 'dst'+target.id);
				newTargetDiv.setAttribute('class', 'entry');
				newTargetDiv.setAttribute('onclick', `dsts.setRouteTo(${target.location[0]}, ${target.location[1]})`);
				newTargetDiv.innerHTML = targetRowContent;
				this.dstsDiv.appendChild(newTargetDiv);
			}
		}
		const now = new Date();
		for(const [id, target] of Object.entries(this.targets)) {
			if(target.expiration < now) this.removeTargetById(target.id);
		}
		if(changed) {
			this.drawTargets();
			this.updateRouteStats();
			this.showPanel();
		}
	}
	
	createTargetRowContent(target) {
		return `
<div class="img"><img src="${target.imageUrl}" width="50px"></div>
<div class="text">
	<div class="row">
		<div class="name">${target.name}</div>
		<div class="details">${target.details}</div>
	</div>
	<div class="row">
		<div class="expiration">${target.expiration.toLocaleTimeString('hu-HU')}</div>
		<div class="status"><div class="destStat"></div><div class="destStat">1</div><div class="destStat">3</div><div class="destStat">5</div><div class="destStat">7</div></div>
	</div>
</div>
<div class="remove" onclick="event.stopPropagation(); dsts.removeTargetByElement(this)">X</div>`;
	}
	
	drawTargets() {
	}
	
	showPanel() {
		document.getElementById('trackerBarContainer').classList.remove('hidden');
	}
	
	updateRouteStats(onlyNew=true) {
		const srcPos = (this.mapUI.rSourceMarker == null) ? null : this.mapUI.rSourceMarker.getLngLat();
		if(srcPos == null) return;

		if(this.calculatingRoute) {
			this.scheduleRecalculation = true;
			return;
		}
		this.calculatingRoute = true;

		var targets = Object.values(this.targets).map(target => {return {id:target.id, dst:target.location, expiration:target.expiration.getTime(), name:target.name, details:target.details}});
		if(onlyNew) {
			targets = targets.filter(target => !('arrivals' in this.targets[target.id]??{}));
		}
		const task = {task:'timing', src:[srcPos.lat, srcPos.lng], targets:targets};
		console.log('updateRouteStats', task);
		this.mapUI.worker.postMessage(task);
	}
	
	processRouteStats(stats) {
		if('last' in stats && stats.last) {
			console.log('calculatingRoute := false');
			this.calculatingRoute = false;
			if(this.scheduleRecalculation) {
				this.scheduleRecalculation = false;
				this.updateRouteStats();
			}
		}
		const delayToChildIndMap = {'0':0,'1':1,'3':2,'5':3,'7':4};
		for(const target of stats.targets) {
			const statusContainer = document.querySelector('#dst'+target.id+" .status");
			if(!statusContainer) continue;
			this.targets[target.id].arrivals = target.arrivals;
			this.targets[target.id].quickArrivals = target.quickArrivals;
			
			for(const [delay, childInd] of Object.entries(delayToChildIndMap)) {
				const arrival = target.arrivals[delay];
				const quickArrival = target.quickArrivals[delay] ?? arrival;
				const statDiv = statusContainer.children[childInd];

				var statStyle = '';
				if(arrival < target.expiration - 3*60000) statStyle='Easy';
				else if(arrival < target.expiration - 1*60000) statStyle='Reachable';
				else if(arrival < target.expiration) statStyle='Risky';
				else {
					if(quickArrival < target.expiration) statStyle='Hard';
					else if(quickArrival >= target.expiration) statStyle='Impossible';
					else statStyle='Unset';
				}
				statDiv.setAttribute('class','destStat '+statStyle);
			}
		}
	}
	
	setRouteTo(lat, lng) {
		console.log('setRouteTo', lat, lng);
		if(this.mapUI.rSourceMarker == null) return;
		this.mapUI._addMarkerOnClickEventHandler({lngLat:{lat:lat, lng:lng}});
		
		const bounds = new maplibregl.LngLatBounds({lat:lat, lng:lng}, this.mapUI.rSourceMarker.getLngLat());
		console.log("bottom padding", document.getElementById('trackerBarContainer').clientHeight);
		this.mapUI.map.fitBounds(bounds, {padding:{top: 10, bottom:document.getElementById('trackerBarContainer').clientHeight+10 ?? 20, left: 10, right: 10}});
	}
}