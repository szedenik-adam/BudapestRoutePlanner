
var m_heatmap = {rowCount:0, downScale:0, canvas:null, palette:'discrete', resampling:'linear'};

function createHeatmap()
{
	const downScale = 10;
	const mapWidth = map.getCanvas().width;
	const mapHeight = map.getCanvas().height;
	const imgWidth = Math.ceil(mapWidth/downScale);
	const imgHeight = Math.ceil(mapHeight/downScale);
	const startTime = Date.now();

	m_heatmap.rowCount = imgHeight;
	m_heatmap.downScale = downScale;

	if(!m_heatmap.canvas) {
		m_heatmap.canvas = document.createElement("canvas");
	}
	m_heatmap.canvas.width = imgWidth;
	m_heatmap.canvas.height = imgHeight;

	var mx = Array.from(Array(imgHeight), () => Array.from(Array(imgWidth)));
	const mapBounds = map.getBounds();
	for(var y = 0; y < mx.length; y++) {
		const row = mx[y];
		for(var x = 0; x < row.length; x++) {
			row[x] = map.unproject([x*downScale+downScale/2, y*downScale+downScale/2]);
		}
		const msg = {src:(mapUI.rSourceMarker) ? mapUI.rSourceMarker.getLngLat() : map.getCenter(), rowInd:y, row:row, startTime:startTime};
		mapUI.worker.postMessage(msg);
	}
}

function receiveHeatmapMessage(msg)
{
	const imgWidth = msg.row.length;
	const imgHeight = m_heatmap.rowCount;
	const downScale = m_heatmap.downScale;

	const imgArr = new Uint8ClampedArray(imgWidth*4);
	for(var i=0; i<imgWidth*4; i+=4) {
		if(m_heatmap.palette == 'discrete') {
			if(msg.row[i/4] < 5*60) {
				imgArr[i+0]=255;
				imgArr[i+1]=255;
				imgArr[i+2]=255;
			} else if(msg.row[i/4] < 10*60) {
				imgArr[i+0]=0;
				imgArr[i+1]=0;
				imgArr[i+2]=255;
			} else if(msg.row[i/4] < 15*60) {
				imgArr[i+0]=0;
				imgArr[i+1]=100;
				imgArr[i+2]=200;
			} else if(msg.row[i/4] < 20*60) {
				imgArr[i+0]=0;
				imgArr[i+1]=200;
				imgArr[i+2]=200;
			} else if(msg.row[i/4] < 25*60) {
				imgArr[i+0]=0;
				imgArr[i+1]=255;
				imgArr[i+2]=0;
			} else if(msg.row[i/4] < 30*60) {
				imgArr[i+0]=255;
				imgArr[i+1]=255;
				imgArr[i+2]=0;
			} else if(msg.row[i/4] < 40*60) {
				imgArr[i+0]=170;
				imgArr[i+1]=100;
				imgArr[i+2]=0;
			} else if(msg.row[i/4] < 50*60) {
				imgArr[i+0]=170;
				imgArr[i+1]=50;
				imgArr[i+2]=0;
			} else if(msg.row[i/4] < 60*60) {
				imgArr[i+0]=255;
				imgArr[i+1]=0;
				imgArr[i+2]=0;
			} else{
				imgArr[i+0]=0;
				imgArr[i+1]=0;
				imgArr[i+2]=0;
			}
		} else {
			var intensity = msg.row[i/4]-5*60;
			if(intensity<0) intensity=0;
			intensity /= 60*30;
			intensity = 1 - intensity;
			if(intensity<0) intensity=0;
			const color = hslToRgb(intensity, 1, 0.5);
			imgArr[i+0]=color[0];
			imgArr[i+1]=color[1];
			imgArr[i+2]=color[2];
		}

		imgArr[i+3]=200;
	}
	
	const canvas = m_heatmap.canvas;
	const ctx = canvas.getContext('2d');
	let imageData = new ImageData(imgArr, imgWidth);
	ctx.putImageData(imageData, 0, msg.rowInd);
	
	if(msg.rowInd == m_heatmap.rowCount-1) {
		var dataURL = canvas.toDataURL();

		const srcCoords = [
			Object.values(map.unproject([0, 0])),
			Object.values(map.unproject([imgWidth*downScale, 0])),
			Object.values(map.unproject([imgWidth*downScale, imgHeight*downScale])),
			Object.values(map.unproject([0, imgHeight*downScale])),
		];
		const source = map.getSource('heatmap');
		if(!source) {
			map.addSource('heatmap', {
				'type': 'image',
				'url': dataURL,
				'coordinates': srcCoords
			});
		} else {
			source.updateImage({url: dataURL, coordinates: srcCoords});
			console.log('source', source);
		}
		var layer = map.getLayer('heatmap-layer');
		if(layer) {
			map.removeLayer('heatmap-layer');
			layer = null;
		}
		if(!layer) {
			map.addLayer({
				id: 'heatmap-layer',
				'type': 'raster',
				'source': 'heatmap',
				'paint': {
					'raster-fade-duration': 1000,
					'raster-resampling': m_heatmap.resampling ?? 'nearest',
				}
			});
		}
	}
}

class IsochroneControl {
  onAdd(map){
	this.map = map;
	this.container = document.createElement('div');
	this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
	this.container.innerHTML =
	  '<div class="tools-box">' +
	  '<button>' +
	  '<span class="maplibregl-ctrl-icon map-isochrone-button" aria-hidden="true" title="create isochrone layer"></span>' +
	  '</button>' +
	  '</div>';
	this.container.children[0].onclick = (e)=>{
		createHeatmap();
		route.clear();
		};
	return this.container;
  }
  onRemove(){
	this.container.parentNode.removeChild(this.container);
	this.map = undefined;
  }
}



/**
 * Converts an HSL color value to RGB. Conversion formula
 * adapted from http://en.wikipedia.org/wiki/HSL_color_space.
 * Assumes h, s, and l are contained in the set [0, 1] and
 * returns r, g, and b in the set [0, 255].
 *
 * @param   {number}  h       The hue
 * @param   {number}  s       The saturation
 * @param   {number}  l       The lightness
 * @return  {Array}           The RGB representation
 */
function hslToRgb(h, s, l){
    var r, g, b;

    if(s == 0){
        r = g = b = l; // achromatic
    }else{
        var q = l < 0.5 ? l * (1 + s) : l + s - l * s;
        var p = 2 * l - q;
        r = hue2rgb(p, q, h + 1/3);
        g = hue2rgb(p, q, h);
        b = hue2rgb(p, q, h - 1/3);
    }

    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)];
}
function hue2rgb(p, q, t){
	if(t < 0) t += 1;
	if(t > 1) t -= 1;
	if(t < 1/6) return p + (q - p) * 6 * t;
	if(t < 1/2) return q;
	if(t < 2/3) return p + (q - p) * (2/3 - t) * 6;
	return p;
}

function showImage(imgUrl)
{
	const mapWidth = map.getCanvas().width;
	const mapHeight = map.getCanvas().height;

	const srcCoords = [
		Object.values(map.unproject([0, 0])),
		Object.values(map.unproject([mapWidth, 0])),
		Object.values(map.unproject([mapWidth, mapHeight])),
		Object.values(map.unproject([0, mapHeight])),
	];
	const source = map.getSource('heatmap');
	if(!source) {
		map.addSource('heatmap', {
			'type': 'image',
			'url': imgUrl,
			'coordinates': srcCoords
		});
	} else {
		source.updateImage({url: imgUrl, coordinates: srcCoords});
		console.log('source', source);
	}
	var layer = map.getLayer('heatmap-layer');
	if(!layer) {
		map.addLayer({
			id: 'heatmap-layer',
			'type': 'raster',
			'source': 'heatmap',
			'paint': {
				'raster-fade-duration': 1000
			}
		});
	}
}