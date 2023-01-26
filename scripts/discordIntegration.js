var dc = null, dsts = null;

class DestinationsControl {
  onAdd(map){
	this.map = map;
	this.container = document.createElement('div');
	this.container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
	this.container.innerHTML =
	  '<div class="tools-box">' +
	  '<button>' +
	  '<span class="maplibregl-ctrl-icon map-destinations-button" aria-hidden="true" title="enable destinations"></span>' +
	  '</button>' +
	  '</div>';
	this.container.children[0].onclick = (e)=>{
		const trackerPanel = document.getElementById('trackerBarContainer');
		if(trackerPanel.classList.contains('hidden')) {
			trackerPanel.classList.remove('hidden');
			if(dsts == null) {InitDiscord();}
		} else {
			InitDiscord();
		}
	};
	return this.container;
  }
  onRemove(){
	this.container.parentNode.removeChild(this.container);
	this.map = undefined;
  }
}

function InitDiscord() {
	if(dsts == null) { dsts = new DestinationsUI(mapUI); }
	dsts.showPanel();

	var access_token = localStorage.getItem('access_token');
	if(!access_token) {
		access_token = prompt('Discord access token');
		localStorage.setItem('access_token', access_token);
	}
	dc = new Discord(null);
	dc.start(access_token);
}

class Discord {
	constructor(onTargetsChanged) {
		this.ws = null;
		this.wshb = null;
		this.inflator = null;
		this.targets = {};
	}

	parseTargetFromMessage(message, now) {
		var result = null;
		if(message == null) return null;
		if('embeds' in message && message['embeds'].length > 0) {
			const msgE = message.embeds[0];
			var nameMatch;
			if('title' in msgE && (nameMatch = msgE.title.match(/Egy (.*?) felbukkant/))) {
				try {
					const id = message.id;
					const name = nameMatch[1];
					const imageUrl = msgE.thumbnail.url.replaceAll('uicons','uicons-outline');
					
					var locationMatch = msgE.description.match(/www.google.com\/maps\/search\/\?[\w|=|&]*?&query=([0-9|\.]*),([0-9|\.]*)/);
					if(locationMatch == null) locationMatch = msgE.description.match(/maps.google.com\/maps\?q=([0-9|\.]*),([0-9|\.]*)/);
					const location = [parseFloat(locationMatch[1]),parseFloat(locationMatch[2])];
					
					const detailsMatch = msgE.description.match(/Szint: ([0-9]*) - CP: ([0-9]*) - IV: ([0-9]*)%\nA:([0-9]*) - D:([0-9]*) - S:([0-9]*)/);
					const details = `${detailsMatch[4]}/${detailsMatch[5]}/${detailsMatch[6]} (${detailsMatch[3]}%) | CP ${detailsMatch[2]} | Level ${detailsMatch[1]}`;
					
					const expirationTimeMatch = msgE.description.match(/Elérhető: (.*?)-ig/);
					const expirationTimeStr = expirationTimeMatch[1];
					var expirationTime = new Date();
					const timePartsMatch = expirationTimeStr.match(/([0-9]*):([0-9]*):([0-9]*)/);
					expirationTime.setHours(parseInt(timePartsMatch[1]), parseInt(timePartsMatch[2]), parseInt(timePartsMatch[3]));
					if(expirationTime.getTime()-now.getTime() < -22*3600*1000) { expirationTime.setDate(expirationTime.getDate() + 1); }
					
					result = {name:name, location:location, details:details, expiration:expirationTime, imageUrl:imageUrl, id:id};
				} catch (e) {
					console.log('parseTargetFromMessage error:',e);
					return null;
				}
			}
		}
		if(result!=null && 'details' in result && result.details.indexOf('100%')==-1) result = null;
		return result;
	}
	
	start(access_token) {
	  fetch('https://discord.com/api/v9/users/@me',{
			headers: {
				'Authorization': access_token
			}
	  }).then((response) => response.json())
		.then((response) => {
			console.log(response);
		});
	  fetch('https://discord.com/api/v9/guilds/915280818514042900/channels', {
			headers: {
				'Authorization': access_token
			}
	  }).then((response) => response.json())
		.then((response) => {
			console.log(response);
		});

	  fetch('https://discord.com/api/v9/channels/1008308476566577212/messages?limit=5', { // szfvar IV-100 history
			headers: {
				'Authorization': access_token
			}
	  }).then((response) => {
		  if(!response.ok || response.status!=200){
			  console.log('recent message fetch not ok, clearing access token');
			  localStorage.removeItem('access_token');
		  }
		  return response.json();
		})
		.then((response) => {
			console.log(response);
			try {
				const now = new Date();
				for(const message of response) {
					const target = this.parseTargetFromMessage(message, now);
					if(target) {
						this.targets[target.id] = target;
						console.log('DC got target:', target);
					}
				}
				if(this.targets){
					dsts.pushChanges(this.targets);
					this.targets = {};
				}
			}
			catch(e){console.error('DC: Last messages\' reading failed!', e);}
			
			if(this.ws!=null){this.ws.close();}

			this.inflator = new Zlib.InflateStream();
			if(this.wshb) {
				clearInterval(this.wshb);
				this.wshb = null;
			}
			
			this.ws = new WebSocket("wss://gateway.discord.gg/?encoding=json&v=9&compress=zlib-stream");
			this.ws.binaryType = "arraybuffer";
			this.ws.addEventListener('open', (event) => {
			  this.ws.send(JSON.stringify({"op":2,"d":{"token":access_token,"capabilities":4093,"properties":{"os":"Windows","browser":"Firefox","device":"","browser_user_agent":"Mozilla/5.0 (Windows NT 6.3; Win64; x64; rv:105.0) Gecko/20100101 Firefox/105.0","browser_version":"105.0","os_version":"8.1","referrer":"https://test.pokebud.pw/","referring_domain":"test.pokebud.pw","referrer_current":"","referring_domain_current":"","release_channel":"stable","client_build_number":165485,"client_event_source":null},"presence":{"status":"online","since":0,"activities":[],"afk":false},"compress":false,"client_state":{"guild_versions":{},"highest_last_message_id":"0","read_state_version":0,"user_guild_settings_version":-1,"user_settings_version":-1,"private_channels_version":"0","api_code_version":0}}}));
			  this.wshb = setInterval(()=> {
				  if(this.ws && this.ws.readyState==WebSocket.OPEN){
					  const hb = `{"op":1,"d":${Math.floor(Math.random() * (1100 - 100 + 1)) + 100}}`;
					  this.ws.send(hb);
					  console.log('WS HB:',hb);
				  }
				  if(!this.ws) {clearInterval(this.wshb); this.wshb=null;}
				}, 30000)
			});
			this.ws.addEventListener("message", (event) => {
			  if (event.data instanceof ArrayBuffer) {
				// binary frame
				const u8Arr = new Uint8Array(event.data);
//				console.log("WS read bin",u8Arr.length);
				
				const decoded = this.inflator.decompress(u8Arr);
				var message = new TextDecoder("utf-8").decode(decoded);
				try{message=JSON.parse(message);}catch(e){console.log(e);}
//				console.log('WS', message);
				
				if('d' in message) {
					const target = this.parseTargetFromMessage(message.d, new Date());
					if(target) {dsts.pushChanges([target]);}
				}
			  } else {
				// text frame
				console.log(event.data);
			  }
			});
		});
	}
}