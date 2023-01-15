const dayZero = (new Date(2000,0,1)).getTime();
var walkSpeed = 5/3600;
var transferWait = 1*60;

async function GTFS(db, zip = null) {
	var startTime = performance.now();
	var me = {};
	formats.forEach(format => {
		format.fields.forEach(f => {
			if(f.type == 'primary-key') {
				me[f.id] = {};
				me[f.id+'N'] = -1;
			}
		});
	});

	var data = {};
	me.data = data;
	
	const progressMapper = (typeof ProgressLinearizer !== 'undefined') ? new ProgressLinearizer('GTFS parsing', db) : null;
	if (progressMapper) {await progressMapper.load();}

	var streamPromise = new Promise(function(resolve,reject){
		const decoder = new TextDecoder();
		var file = "", table=null, format=null, remainder=null;
		var zipStream = zip.generateInternalStream({type:"uint8array"})
		.on('data', function (data, metadata) {
			if (progressMapper) {progressMapper.update(metadata.percent/100);}
			function ParseLine2(line, format, me, decoder) {
				line = decoder.decode(line);
				var entry = Array(format.length);
				var fieldNum = 0, lineStart = 0, commaPos=0, endOffset;
				while(lineStart < line.length) {
					commaPos = line.indexOf(',', lineStart);
					if(commaPos == -1) commaPos = line.length;
					endOffset = 0;
					if(commaPos == lineStart+1) { } // empty entry
					else if(line[lineStart] == '"') { // text between "
						lineStart++;
						if(line[commaPos-1] != '"') {
							var aposPos = commaPos;
							do { aposPos = line.indexOf('"', aposPos+1); } while (aposPos!=-1 && line[aposPos-1]=='\\');
							if (aposPos!=-1) { commaPos=aposPos+1; endOffset = 1;}
						}
					}
					const ff = format[fieldNum];
					// field is between lineStart to commaPos-1-endOffset
					const str = line.substring(lineStart, commaPos-endOffset);
					if(ff.parse) entry[fieldNum] = ff.parse(str, me);
					
					lineStart = commaPos + 1;
					fieldNum++;
				}
				return entry;
			}
			if(metadata.currentFile == null) {
				console.log('last on-data');
				if(remainder) { // process previous file's last line.
					entry = ParseLine2(remainder, format, me, decoder);
					me.data[table].push(entry);
					remainder = null;
				}
				return;
			}
			if(metadata.currentFile != file) {
				if(remainder) { // process previous file's last line.
					entry = ParseLine2(remainder, format, me, decoder);
					me.data[table].push(entry);
					remainder = null;
				}
				file = metadata.currentFile;
				format = null;
				remainder = null;
				table = file.substring(0,file.indexOf('.'));
				me.data[table]=[];
				if(data.length > 4 && data[0]==80 && data[1]==75 && data[2]==3 && data[3]==4) return;
			}
			var startPos = 0;
			var newlinePos;
			while((newlinePos = data.indexOf(10, startPos)) != -1) {
				if(format == null) {
					var formatLine;
					if (remainder == null) {
						formatLine = data.subarray(0, newlinePos);
					} else {
						formatLine = new Uint8Array(remainder.length + newlinePos);
						formatLine.set(remainder);
						formatLine.set(data.subarray(0, newlinePos), remainder.length);
						remainder = null;
					}
					formatLine = decoder.decode(formatLine);
					format = ParseLine(formatLine);
					for(const fileFormat of formats) {
						if(fileFormat.id==table) {
							for(var fi=0;fi<format.length;fi++) {
								for(const field of fileFormat.fields) {
									if(format[fi]==field.id) {
										format[fi]={name:field.id,type:field.type,parse:GetFormatParser(field.type, field.id)};
										break;
									}
								}
								if(typeof format[fi] !== 'object') {format[fi] = {name:format[fi],type:'null',parse:null}}
							}
							break;
						}
					}
					me[table+"_f"] = new Map();
					format.forEach((f,fi) => { me[table+"_f"].set(f.name, fi) });
					console.log('format', metadata.currentFile, formatLine, format, me[table+"_f"]);
				} else {
					var entry;
					if(remainder) {
						var line = new Uint8Array(remainder.length + newlinePos - startPos);
						line.set(remainder);
						line.set(data.subarray(startPos, newlinePos), remainder.length);
						remainder = null;
						entry = ParseLine2(line, format, me, decoder);
					} else {
						var line = data.subarray(startPos, newlinePos);
						entry = ParseLine2(line, format, me, decoder);
					}
					me.data[table].push(entry);
				}
				startPos = newlinePos + 1;
			}
			if(newlinePos == -1) {
				if(startPos == 0) remainder = data;
				else if(startPos < data.length) remainder = data.subarray(startPos);
			}
		})
		.on('error', function (e) {
			console.log("zip-error",e);
			reject(e);
		})
		.on('end', function () {
			console.log("zip-end");
			resolve('');
		})
		.resume();
	});
	await streamPromise;
	
	var endTime = performance.now();
	console.log(`gtfs.zip parsing took ${(endTime - startTime)/1000} seconds`);
	
	var shapes = [];
	const shape_id_pos = me.shapes_f.get('shape_id');
	const shape_pt_sequence_pos = me.shapes_f.get('shape_pt_sequence');
	const shape_pt_lat_pos = me.shapes_f.get('shape_pt_lat');
	const shape_pt_lon_pos = me.shapes_f.get('shape_pt_lon');
	const shape_pt_dist_pos = me.shapes_f.get('shape_dist_traveled');
	data.shapes.sort((a, b) => { return a[shape_pt_sequence_pos] > b[shape_pt_sequence_pos] });
	for (const shapeRow of data.shapes) {
		const sid = shapeRow[shape_id_pos];
		const point = [shapeRow[shape_pt_dist_pos], shapeRow[shape_pt_lon_pos], shapeRow[shape_pt_lat_pos]]
		if(shapes.length > sid && shapes[sid]!==undefined) shapes[sid].push(point);
		else shapes[sid]=[point];
	}
	me.shapes = shapes;

	me.dayRange = function() {
		var min = Number.MAX_SAFE_INTEGER, max = 0;
		const dateInd = me.calendar_dates_f.get('date');
		data.calendar_dates.forEach(cd => {
			if(min > cd[dateInd]) min = cd[dateInd];
			if(max < cd[dateInd]) max = cd[dateInd];
		})
		return [min, max];
	}
	
	me.extractCommon = function() { // save stops and shapes and routes.
		console.log('serializeCommon');
		// init routes
		var routes = new Map();
		const r_id_pos = me.routes_f.get('route_id');
		const r_short_name_pos = me.routes_f.get('route_short_name');
		const r_long_name_pos = me.routes_f.get('route_long_name');
		const r_color_pos = me.routes_f.get('route_color');
		const r_text_color_pos = me.routes_f.get('route_text_color');
		data.routes.forEach(r => {
			routes.set(r[r_id_pos], {
				name: r[r_short_name_pos].length > 0 ? r[r_short_name_pos] : r[r_long_name_pos],
				color: [r[r_color_pos], r[r_text_color_pos]],
				trips: [],
				_id: r[r_id_pos]
			})
		});
		
		// init stops
		var stops = new Map();
		const s_id_pos = me.stops_f.get('stop_id');
		const s_name_pos = me.stops_f.get('stop_name');
		const s_lat_pos = me.stops_f.get('stop_lat');
		const s_lon_pos = me.stops_f.get('stop_lon');
		const s_dir_pos = me.stops_f.get('stop_direction');
		data.stops.forEach(s => {
			stops.set(s[s_id_pos], {
				name:s[s_name_pos],
				lat:s[s_lat_pos],
				lon:s[s_lon_pos],
				neighbours:[],
				dir:s[s_dir_pos] ?? null,
				_id: s[s_id_pos]
			});
		});
		stops.forEach(s => {
			// add nearby stops: (not yet: min 10 stop) max 300 meter
			var neighbourStops = [];
			stops.forEach( ns => {
				if(s == ns) return;
				const distSqr = sqr((s.lon-ns.lon)*71.6) + sqr((s.lat-ns.lat)*111.3);
				if(distSqr < 0.3*0.3) {
					const dist = Math.sqrt(distSqr);
					neighbourStops.push({s:ns, dist:dist});
				}
			});
			s.neighbours = neighbourStops;
		});
		
		// linearize
		stops = Array.from(stops.values());
		stops.forEach((s,i) => s._index = i);
		stops.forEach(s => s.neighbours.forEach(ns => ns.s = ns.s._index));
		routes = Array.from(routes.values());
		routes.forEach((r,i) => r._index = i);
		
		return {range:me.dayRange(), stops:stops, routes:routes, shapes:shapes, stopMap:me.stop_id, routeMap:me.route_id};
	}
	me.serializeDay = function(startDay, common) {
		console.log('serializeDay', startDay, common);

		// init services
		var services = new Map();
		const t_sid_pos = me.trips_f.get('service_id');
		data.trips.forEach(t => {
			if (!services.has(t[t_sid_pos])) {
				services.set(t[t_sid_pos], {
					dates:new Set(),
					trips:[]
				});
			}
		})

		// init trips
		var trips = new Map();
		const t_id_pos = me.trips_f.get('trip_id');
		const t_rid_pos = me.trips_f.get('route_id');
		const t_shape_id_pos = me.trips_f.get('shape_id');
		data.trips.forEach(t => {
			var route = common.routes[t[t_rid_pos]];
			var service = services.get(t[t_sid_pos]);
			var trip = {
				route:route,
				service:service,
				stops:[],
				shape_id:t[t_shape_id_pos]
			}
			if(route == undefined) {
				console.log('undefined route', t[t_rid_pos]);
			}
			route.trips.push(trip);
			service.trips.push(trip);
			trips.set(t[t_id_pos], trip);
		})

		// init stops
		var stops = Array.from(Array(common.stops.length), () => {});
		common.stops.forEach(s => {
			stops[s._id]={
				trips:[],
				_id:s._id,
				_use:false
			};
		});

		// init stop_times
		var stop_times = new Map();
		const st_tid_pos = me.stop_times_f.get('trip_id');
		const st_sid_pos = me.stop_times_f.get('stop_id');
		const st_seq_pos = me.stop_times_f.get('stop_sequence');
		const st_arr_pos = me.stop_times_f.get('arrival_time');
		const st_dep_pos = me.stop_times_f.get('departure_time');
		const st_dist_pos = me.stop_times_f.get('shape_dist_traveled');
		data.stop_times.forEach(st => {
			var trip = trips.get(st[st_tid_pos]);
			var stop = stops[st[st_sid_pos]];
			trip.stops[st[st_seq_pos]] = [st[st_arr_pos],st[st_dep_pos],stop,st[st_dist_pos]]
		})
		trips.forEach(t => {
			t.stops = t.stops.filter(s => s);
			t.stopArr = t.stops.map(s => s[0]);
			t.stopDep = t.stops.map(s => s[1]);
			t.stopShapeDist = t.stops.map(s => s[3]);
			t.stops   = t.stops.map(s => s[2]);
		})
		for (const [tripOriginalId, tripInd] of Object.entries(me.trip_id)) {
			trips.get(tripInd).originalInd = tripOriginalId;
		};


		// now clean up
		if('calendar' in data) {data.calendar.forEach(c => { throw Error() });}

		const cd_date_pos = me.calendar_dates_f.get('date');
		const cd_exception_type_pos = me.calendar_dates_f.get('exception_type');
		const cd_service_id_pos = me.calendar_dates_f.get('service_id');
		data.calendar_dates.forEach(d => {
			if (d[cd_date_pos] != startDay) return;
			//if (d[cd_date_pos] >   endDay) return;

			if (d[cd_exception_type_pos] !== 1) {
				throw Error();
			}

			var service = services.get(d[cd_service_id_pos]);
			if(!service){
				console.warn('service not found', d[cd_service_id_pos]);
				return;
			}
			service.dates.add(d[cd_date_pos] - startDay);
			service._use = true;
		})

		// which object is in use?
		services.forEach(s => {
			if (!s._use) return;
			s.trips.forEach(t => {
				t._use = true;
				t.route._use = true;
				t.stops.forEach(
					s => 
					s._use = true
				);
			})
		});

		common.routes.forEach(r => { r.trips = []; });
		
		// linearize
		services = Array.from(services.values());
		services = services.filter(s => s._use);
		services.forEach((s,i) => {
			s.dates = Array.from(s.dates.values());
			s.dates.sort();
			delete s.trips;
			s._index = i;
		});
		
		var tripMap = {};
		trips = Array.from(trips.values());
		trips = trips.filter(t => t._use);
		trips.forEach((t,i) => {
			t.route = t.route._id;
			t.service = t.service._index;
			t.stops = t.stops.map(s => s._id);
			delete t._use;
			t._index = i;
			tripMap[t.originalInd] = i;
			delete t.originalInd;
		});

		stops.forEach(s => (delete s._index, delete s._use, delete s._id));
		services.forEach(s => (delete s._index, delete s._use));

		trips.forEach(function (trip) {
			//trip.route = common.routes[trip.route];
			//trip.service = services[trip.service];
			//trip.dates = trip.service.dates;
			trip.stops.forEach(function (stop_index, index) {
				var stop = stops[stop_index];
				if(index < trip.stops.length-1) { // Don't add trip to the final stop (not needed for departures).
					stop.trips.push([trip._index,index]);
				}
			});
		});
		trips.forEach(t => (delete t._index));

		stops.forEach(function (stop) {
			stop.trips.sort((a, b) => trips[a[0]].stopDep[a[1]] - trips[b[0]].stopDep[b[1]]);
		});

		services = compactArray(services);
		trips = compactArray(trips);
		stops = compactArray(stops);

		var result = {
			start_date: startDay,
			c_range:common.range,
			services: services,
			trips: trips,
			stops: stops,
			tripMap: tripMap,
		}
		return result;
	}
	
	me.extract = function (startDate) {
		var startDay = date2days(startDate);
		var result = me.extractDay(startDay);
		if(typeof result === 'object') {
			result.day_diff = 0;
			return result;
		}
		if(typeof result === 'number') {
			const diff = startDay - result + 7;
			const mod7 = diff % 7;
			const decr = diff - (mod7 ? mod7-7 : 0);
			startDay-= decr;
			result = me.extractDay(startDay);
			result.day_diff = decr;
			return result;
		}
		return {};
	}
	
	me.extractDay = function (startDay) {
		var endDay = startDay+7;

		// init routes
		var routes = new Map();
		const r_id_pos = me.routes_f.get('route_id');
		const r_short_name_pos = me.routes_f.get('route_short_name');
		const r_long_name_pos = me.routes_f.get('route_long_name');
		const r_color_pos = me.routes_f.get('route_color');
		const r_text_color_pos = me.routes_f.get('route_text_color');
		data.routes.forEach(r => {
			routes.set(r[r_id_pos], {
				name: r[r_short_name_pos].length > 0 ? r[r_short_name_pos] : r[r_long_name_pos],
				color: [r[r_color_pos], r[r_text_color_pos]],
				trips: []
			})
		})

		// init services
		var services = new Map();
		const t_sid_pos = me.trips_f.get('service_id');
		data.trips.forEach(t => {
			if (!services.has(t[t_sid_pos])) {
				services.set(t[t_sid_pos], {
					dates:new Set(),
					trips:[]
				});
			}
		})

		// init trips
		var trips = new Map();
		const t_id_pos = me.trips_f.get('trip_id');
		const t_rid_pos = me.trips_f.get('route_id');
		const t_shape_id_pos = me.trips_f.get('shape_id');
		data.trips.forEach(t => {
			var route = routes.get(t[t_rid_pos]);
			var service = services.get(t[t_sid_pos]);
			var trip = {
				route:route,
				service:service,
				stops:[],
				shape_id:t[t_shape_id_pos]
			}
			if(route == undefined) {
				console.log('undefined route', t[t_rid_pos]);
			}
			route.trips.push(trip);
			service.trips.push(trip);
			trips.set(t[t_id_pos], trip);
		})

		// init stops
		var stops = new Map();
		const s_id_pos = me.stops_f.get('stop_id');
		const s_name_pos = me.stops_f.get('stop_name');
		const s_lat_pos = me.stops_f.get('stop_lat');
		const s_lon_pos = me.stops_f.get('stop_lon');
		const s_dir_pos = me.stops_f.get('stop_direction');
		data.stops.forEach(s => {
			stops.set(s[s_id_pos], {
				name:s[s_name_pos],
				lat:s[s_lat_pos],
				lon:s[s_lon_pos],
				dir:s[s_dir_pos] ?? null
			});
		});

		// init stop_times
		var stop_times = new Map();
		const st_tid_pos = me.stop_times_f.get('trip_id');
		const st_sid_pos = me.stop_times_f.get('stop_id');
		const st_seq_pos = me.stop_times_f.get('stop_sequence');
		const st_arr_pos = me.stop_times_f.get('arrival_time');
		const st_dep_pos = me.stop_times_f.get('departure_time');
		const st_dist_pos = me.stop_times_f.get('shape_dist_traveled');
		data.stop_times.forEach(st => {
			var trip = trips.get(st[st_tid_pos]);
			var stop = stops.get(st[st_sid_pos]);
			trip.stops[st[st_seq_pos]] = [st[st_arr_pos],st[st_dep_pos],stop,st[st_dist_pos]]
		})
		trips.forEach(t => {
			t.stops = t.stops.filter(s => s);
			t.stopArr = t.stops.map(s => s[0]);
			t.stopDep = t.stops.map(s => s[1]);
			t.stopShapeDist = t.stops.map(s => s[3]);
			t.stops   = t.stops.map(s => s[2]);
		})
		for (const [tripOriginalId, tripInd] of Object.entries(me.trip_id)) {
			trips.get(tripInd).originalInd = tripOriginalId;
		};

		// now clean up
		if('calendar' in data) {data.calendar.forEach(c => { throw Error() });}

		var lastDay = 0;
		const cd_date_pos = me.calendar_dates_f.get('date');
		const cd_exception_type_pos = me.calendar_dates_f.get('exception_type');
		const cd_service_id_pos = me.calendar_dates_f.get('service_id');
		data.calendar_dates.forEach(d => {
			lastDay = Math.max(lastDay, d[cd_date_pos]);
			if (d[cd_date_pos] < startDay) return;
			if (d[cd_date_pos] >   endDay) return;

			if (d[cd_exception_type_pos] !== 1) {
				throw Error();
			}

			var service = services.get(d[cd_service_id_pos]);
			if(!service){
				console.warn('service not found', d[cd_service_id_pos]);
				return;
			}
			service.dates.add(d[cd_date_pos] - startDay);
			service._use = true;
			lastDay = Number.MAX_SAFE_INTEGER;
		})
		if(lastDay != Number.MAX_SAFE_INTEGER) return lastDay;

		// which object is in use?
		services.forEach(s => {
			if (!s._use) return;
			s.trips.forEach(t => {
				t._use = true;
				t.route._use = true;
				t.stops.forEach(s => s._use = true);
			})
		})

		// linearize
		stops = Array.from(stops.values());
		stops = stops.filter(s => s._use);
		stops.forEach((s,i) => s._index = i);

		routes = Array.from(routes.values());
		routes = routes.filter(r => r._use);
		routes.forEach((r,i) => {
			delete r.trips;
			r._index = i
		});

		services = Array.from(services.values());
		services = services.filter(s => s._use);
		services.forEach((s,i) => {
			s.dates = Array.from(s.dates.values());
			s.dates.sort();
			delete s.trips;
			s._index = i;
		});
		
		var tripMap = {};
		trips = Array.from(trips.values());
		trips = trips.filter(t => t._use);
		trips.forEach((t,i) => {
			t.route = t.route._index;
			t.service = t.service._index;
			t.stops = t.stops.map(s => s._index);
			delete t._use;
			tripMap[t.originalInd] = i;
			delete t.originalInd;
		});

		stops.forEach(s => (delete s._index, delete s._use));
		routes.forEach(r => (delete r._index, delete r._use));
		services.forEach(s => (delete s._index, delete s._use));
		
		stops.forEach(function (stop) {
			stop.trips = [];
			
			// add nearby stops: (not yet: min 10 stop) max 300 meter
			var neighbourStops = [];
			stops.forEach( ns => {
				if(stop == ns) return;
				const distSqr = sqr((stop.lon-ns.lon)*71.6) + sqr((stop.lat-ns.lat)*111.3);
				if(distSqr < 0.3*0.3) {
					const dist = Math.sqrt(distSqr);
					neighbourStops.push({stop:ns, dist:dist});
				}
			});
			stop.neighbours = neighbourStops;
		});

		trips.forEach(function (trip) {
			trip.route = routes[trip.route];
			trip.service = services[trip.service];
			trip.dates = trip.service.dates;
			trip.stops = trip.stops.map(function (stop_index, index) {
				var stop = stops[stop_index];
				if(index < trip.stops.length-1) { // Don't add trip to the final stop (not needed for departures).
					stop.trips.push([trip,index]);
				}
				return stop;
			});
		});

		stops.forEach(function (stop) {
			stop.trips.sort((a, b) => a[0].stopDep[a[1]] - b[0].stopDep[b[1]]);
		});

		var result = {
			start_date: days2string(startDay),
			stops: stops,
			routes: routes,
			services: services,
			trips: trips,
			shapes: shapes,
			
			stopMap:me.stop_id,
			routeMap:me.route_id,
			tripMap:tripMap, // me.trip_id contains all trips.
		}

		return result;

		function ao2oa(list) {
			if (list.length === 0) return null;
			var keys = new Set();
			list.forEach(
				entry => Object.keys(entry).forEach(
					key => keys.add(key)
				)
			);
			var obj = {};
			Array.from(keys.values()).forEach(key => {
				obj[key] = list.map(entry => entry.hasOwnProperty(key) ? entry[key] : null);
			})
			return obj;
		}

	}

	return me;
}

// Source: https://developers.google.com/transit/gtfs/reference/
var formats = ([
	{
		id:'agency',
		required:true,
		details:'One or more transit agencies that provide the data in this feed.',
		fields:[
			{id:'agency_id',type:'string',required:false,details:'Uniquely identifies a transit agency. A transit feed may represent data from more than one agency. The agency_id is dataset unique. This field is optional for transit feeds that only contain data for a single agency.'},
			{id:'agency_name',type:'string',required:true,details:'The agency_name field contains the full name of the transit agency. Google Maps will display this name.'},
			{id:'agency_url',type:'string',required:true,details:'Contains the URL of the transit agency. The value must be a fully qualified URL that includes http:// or https://, and any special characters in the URL must be correctly escaped. See http://www.w3.org/Addressing/URL/4_URI_Recommentations.html for a description of how to create fully qualified URL values.'},
			{id:'agency_timezone',type:'string',required:true,details:'Contains the timezone where the transit agency is located. Timezone names never contain the space character but may contain an underscore. Please refer to http://en.wikipedia.org/wiki/List_of_tz_zones for a list of valid values. If multiple agencies are specified in the feed, each must have the same agency_timezone.'},
			{id:'agency_lang',type:'string',required:false,details:'Contains a two-letter ISO 639-1 code for the primary language used by this transit agency. The language code is case-insensitive (both en and EN are accepted). This setting defines capitalization rules and other language-specific settings for all text contained in this transit agency\'s feed. Please refer to http://www.loc.gov/standards/iso639-2/php/code_list.php for a list of valid values.'},
			{id:'agency_phone',type:'string',required:false,details:'Contains a single voice telephone number for the specified agency. This field is a string value that presents the telephone number as typical for the agency\'s service area. It can and should contain punctuation marks to group the digits of the number. Dialable text (for example, TriMet\'s "503-238-RIDE") is permitted, but the field must not contain any other descriptive text.'},
			{id:'agency_fare_url',type:'string',required:false,details:'Specifies the URL of a web page that allows a rider to purchase tickets or other fare instruments for that agency online. The value must be a fully qualified URL that includes http:// or https://, and any special characters in the URL must be correctly escaped. See http://www.w3.org/Addressing/URL/4_URI_Recommentations.html for a description of how to create fully qualified URL values.'},
			{id:'agency_email',type:'string',required:false,details:'Contains a single valid email address actively monitored by the agency’s customer service department. This email address will be considered a direct contact point where transit riders can reach a customer service representative at the agency.'},
		]
	},{
		id:'stops',
		required:true,
		details:'Individual locations where vehicles pick up or drop off passengers.',
		fields:[
			{id:'stop_id',type:'primary-key',required:true,details:'Contains an ID that uniquely identifies a stop or station. Multiple routes may use the same stop. The stop_id is dataset unique.'},
			{id:'stop_code',type:'string',required:false,details:'Contains short text or a number that uniquely identifies the stop for passengers. Stop codes are often used in phone-based transit information systems or printed on stop signage to make it easier for riders to get a stop schedule or real-time arrival information for a particular stop.'},
			{id:'stop_name',type:'string',required:true,details:'Contains the name of a stop or station. Please use a name that people will understand in the local and tourist vernacular.'},
			{id:'stop_desc',type:'string',required:false,details:'Contains a description of a stop. Please provide useful, quality information. Do not simply duplicate the name of the stop.'},
			{id:'stop_lat',type:'float',required:true,details:'Contains the latitude of a stop or station. The field value must be a valid WGS 84 latitude.'},
			{id:'stop_lon',type:'float',required:true,details:'Contains the longitude of a stop or station. The field value must be a valid WGS 84 longitude value from -180 to 180.'},
			{id:'zone_id',type:'string',required:false,details:'Defines the fare zone for a stop ID. Zone IDs are required if you want to provide fare information using fare_rules.txt. If this stop ID represents a station, the zone ID is ignored.'},
			{id:'stop_url',type:'string',required:false,details:'Contains the URL of a web page about a particular stop. This should be different from the agency_url and the route_url fields.'},
			{id:'location_type',type:'int',required:false,details:'Identifies whether this stop ID represents a stop or station. If no location type is specified, or the location_type is blank, stop IDs are treated as stops. Stations can have different properties from stops when they are represented on a map or used in trip planning.'},
			{id:'parent_station',type:'string',required:false,details:'For stops that are physically located inside stations, this field identifies the station associated with the stop. To use this field, stops.txt must also contain a row where this stop ID is assigned location type=1.'},
			{id:'stop_timezone',type:'string',required:false,details:'Contains the timezone in which this stop or station is located. Please refer to Wikipedia List of Timezones for a list of valid values. If omitted, the stop should be assumed to be located in the timezone specified by agency_timezone in agency.txt.'},
			{id:'wheelchair_boarding',type:'int',required:false,details:'Identifies whether wheelchair boardings are possible from the specified stop or station. The field can have the following values:'},
			{id:'stop_direction',type:'int',required:false,details:'Contains the stop\'s departure direction in degrees.'},
		]
	},{
		id:'routes',
		required:true,
		details:'Transit routes. A route is a group of trips that are displayed to riders as a single service.',
		fields:[
			{id:'route_id',type:'primary-key',required:true,details:'Contains an ID that uniquely identifies a route. The route_id is dataset unique.'},
			{id:'agency_id',type:'string',required:false,details:'Defines an agency for the specified route. This value is referenced from the agency.txt file. Use this field when you are providing data for routes from more than one agency.'},
			{id:'route_short_name',type:'string',required:true,details:'Contains the short name of a route. This will often be a short, abstract identifier like "32", "100X", or "Green" that riders use to identify a route, but which doesn\'t give any indication of what places the route serves.'},
			{id:'route_long_name',type:'string',required:true,details:'Contains the full name of a route. This name is generally more descriptive than the route_short_name and will often include the route\'s destination or stop. At least one of route_short_name or route_long_name must be specified, or potentially both if appropriate. If the route does not have a long name, please specify a route_short_name and use an empty string as the value for this field.'},
			{id:'route_desc',type:'string',required:false,details:'Contains a description of a route. Please provide useful, quality information. Do not simply duplicate the name of the route. For example, "A trains operate between Inwood-207 St, Manhattan and Far Rockaway-Mott Avenue, Queens at all times. Also from about 6AM until about midnight, additional A trains operate between Inwood-207 St and Lefferts Boulevard (trains typically alternate between Lefferts Blvd and Far Rockaway)."'},
			{id:'route_type',type:'int',required:true,details:'Describes the type of transportation used on a route. Valid values for this field are:'},
			{id:'route_url',type:'string',required:false,details:'Contains the URL of a web page about that particular route. This should be different from the agency_url.'},
			{id:'route_color',type:'string',required:false,details:'In systems that have colors assigned to routes, this defines a color that corresponds to a route. The color must be provided as a six-character hexadecimal number, for example, 00FFFF. If no color is specified, the default route color is white (FFFFFF).'},
			{id:'route_text_color',type:'string',required:false,details:'Specifies a legible color to use for text drawn against a background of route_color. The color must be provided as a six-character hexadecimal number, for example, FFD700. If no color is specified, the default text color is black (000000).'},
		]
	},{
		id:'shapes',
		required:false,
		details:'Rules for drawing lines on a map to represent a transit organization\'s routes.',
		fields:[
			{id:'shape_id',type:'primary-key',required:true,details:'Identifies a shape.'},
			{id:'shape_pt_lat',type:'float',required:true,details:'Latitude of a shape point.'},
			{id:'shape_pt_lon',type:'float',required:true,details:'Longitude of a shape point.'},
			{id:'shape_pt_sequence',type:'int',required:true,details:'Sequence in which the shape points connect to form the shape. Values must increase along the trip but do not need to be consecutive.'},
			{id:'shape_dist_traveled',type:'float',required:false,details:'Actual distance traveled along the shape from the first shape point to the point specified in this record.'}
		]
	},{
		id:'trips',
		required:true,
		details:'Trips for each route. A trip is a sequence of two or more stops that occurs at specific time.',
		fields:[
			{id:'route_id',type:'foreign-key',required:true,details:'Contains an ID that uniquely identifies a route. This value is referenced from the routes.txt file.'},
			{id:'service_id',type:'primary-key',required:true,details:'The service_id contains an ID that uniquely identifies a set of dates when service is available for one or more routes. This value is referenced from the calendar.txt or calendar_dates.txt file.'},
			{id:'trip_id',type:'primary-key',required:true,details:'Contains an ID that identifies a trip. The trip_id is dataset unique.'},
			{id:'trip_headsign',type:'string',required:false,details:'Contains the text that appears on a sign that identifies the trip\'s destination to passengers. Use this field to distinguish between different patterns of service in the same route. If the headsign changes during a trip, you can override the trip_headsign by specifying values for the the stop_headsign field in stop_times.txt.'},
			{id:'trip_short_name',type:'string',required:false,details:'Contains the text that appears in schedules and sign boards to identify the trip to passengers, for example, to identify train numbers for commuter rail trips. If riders do not commonly rely on trip names, please leave this field blank.'},
			{id:'direction_id',type:'int',required:false,details:'Contains a binary value that indicates the direction of travel for a trip. Use this field to distinguish between bi-directional trips with the same route_id. This field is not used in routing; it provides a way to separate trips by direction when publishing time tables. You can specify names for each direction with the trip_headsign field.'},
			{id:'block_id',type:'string',required:false,details:'Identifies the block to which the trip belongs. A block consists of two or more sequential trips made using the same vehicle, where a passenger can transfer from one trip to the next just by staying in the vehicle. The block_id must be referenced by two or more trips in trips.txt.'},
			{id:'shape_id',type:'foreign-key',required:false,details:'Contains an ID that defines a shape for the trip. This value is referenced from the shapes.txt file. The shapes.txt file allows you to define how a line should be drawn on the map to represent a trip.'},
			{id:'wheelchair_accessible',type:'int',required:false,details:''},
			{id:'bikes_allowed',type:'int',required:false,details:''},
		]
	},{
		id:'stop_times',
		required:true,
		details:'Times that a vehicle arrives at and departs from individual stops for each trip.',
		fields:[
			{id:'trip_id',type:'foreign-key',required:true,details:'Contains an ID that identifies a trip. This value is referenced from the trips.txt file.'},
			{id:'arrival_time',type:'time',required:true,details:'Specifies the arrival time at a specific stop for a specific trip on a route. The time is measured from "noon minus 12h" (effectively midnight, except for days on which daylight savings time changes occur) at the beginning of the service date. For times occurring after midnight on the service date, enter the time as a value greater than 24:00:00 in HH:MM:SS local time for the day on which the trip schedule begins. If you don\'t have separate times for arrival and departure at a stop, enter the same value for arrival_time and departure_time.'},
			{id:'departure_time',type:'time',required:true,details:'Specifies the departure time from a specific stop for a specific trip on a route. The time is measured from "noon minus 12h" (effectively midnight, except for days on which daylight savings time changes occur) at the beginning of the service date. For times occurring after midnight on the service date, enter the time as a value greater than 24:00:00 in HH:MM:SS local time for the day on which the trip schedule begins. If you don\'t have separate times for arrival and departure at a stop, enter the same value for arrival_time and departure_time.'},
			{id:'stop_id',type:'foreign-key',required:true,details:'Contains an ID that uniquely identifies a stop. Multiple routes may use the same stop. The stop_id is referenced from the stops.txt file. If location_type is used in stops.txt, all stops referenced in stop_times.txt must have location_type of 0.'},
			{id:'stop_sequence',type:'int',required:true,details:'Identifies the order of the stops for a particular trip. The values for stop_sequence must be non-negative integers, and they must increase along the trip.'},
			{id:'stop_headsign',type:'string',required:false,details:'Contains the text that appears on a sign that identifies the trip\'s destination to passengers. Use this field to override the default trip_headsign (in trips.txt) when the headsign changes between stops. If this headsign is associated with an entire trip, use trip_headsign instead.'},
			{id:'pickup_type',type:'string',required:false,details:'Indicates whether passengers are picked up at a stop as part of the normal schedule or whether a pickup at the stop is not available. This field also allows the transit agency to indicate that passengers must call the agency or notify the driver to arrange a pickup at a particular stop. Valid values for this field are:'},
			{id:'drop_off_type',type:'string',required:false,details:'Indicates whether passengers are dropped off at a stop as part of the normal schedule or whether a drop off at the stop is not available. This field also allows the transit agency to indicate that passengers must call the agency or notify the driver to arrange a drop off at a particular stop.'},
			{id:'shape_dist_traveled',type:'float',required:false,details:'When used in the stop_times.txt file, this field positions a stop as a distance from the first shape point. The shape_dist_traveled field represents a real distance traveled along the route in units such as feet or kilometers. For example, if a bus travels a distance of 5.25 kilometers from the start of the shape to the stop, the shape_dist_traveled for the stop ID would be entered as "5.25".'},
			{id:'timepoint',type:'string',required:false,details:'Indicates if the specified arrival and departure times for a stop are strictly adhered to by the transit vehicle or if they are instead approximate and/or interpolated times. The field allows a GTFS producer to provide interpolated stop times that potentially incorporate local knowledge, but still indicate if the times are approximate.'},
		]
	},{
		id:'calendar',
		required:false,
		details:'Dates for service IDs using a weekly schedule. Specify when service starts and ends, as well as days of the week where service is available.',
		fields:[
			{id:'service_id',type:'foreign-key',required:true,details:'Contains an ID that uniquely identifies a set of dates when service is available for '},
			{id:'monday',type:'int',required:true,details:'Contains a binary value that indicates whether the service is valid for all Mondays.'},
			{id:'tuesday',type:'int',required:true,details:'Contains a binary value that indicates whether the service is valid for all Tuesdays.'},
			{id:'wednesday',type:'int',required:true,details:'Contains a binary value that indicates whether the service is valid for all Wednesdays.'},
			{id:'thursday',type:'int',required:true,details:'Contains a binary value that indicates whether the service is valid for all Thursdays.'},
			{id:'friday',type:'int',required:true,details:'Contains a binary value that indicates whether the service is valid for all Fridays.'},
			{id:'saturday',type:'int',required:true,details:'Contains a binary value that indicates whether the service is valid for all Saturdays.'},
			{id:'sunday',type:'int',required:true,details:'Contains a binary value that indicates whether the service is valid for all Sundays.'},
			{id:'start_date',type:'date',required:true,details:'The start_date field contains the start date for the service.'},
			{id:'end_date',type:'date',required:true,details:'Contains the end date for the service. This date is included in the service interval.'},
		]
	},{
		id:'calendar_dates',
		required:false,
		details:'Exceptions for the service IDs defined in the calendar.txt file. If calendar_dates.txt includes ALL dates of service, this file may be specified instead of calendar.txt.',
		fields:[
			{id:'service_id',type:'foreign-key',required:true,details:'Contains an ID that uniquely identifies a set of dates when a service exception is available for one or more routes. Each (service_id, date) pair can only appear once in calendar_dates.txt. If the a service_id value appears in both the calendar.txt and calendar_dates.txt files, the information in calendar_dates.txt modifies the service information specified in calendar.txt. This field is referenced by the trips.txt file.'},
			{id:'date',type:'date',required:true,details:'Specifies a particular date when service availability is different than the norm. You can use the exception_type field to indicate whether service is available on the specified date.'},
			{id:'exception_type',type:'int',required:true,details:'Indicates whether service is available on the date specified in the date field.'},
		]
	},{
		id:'fare_attributes',
		required:false,
		details:'Fare information for a transit organization\'s routes.',
		fields:[
		]
	},{
		id:'fare_rules',
		required:false,
		details:'Rules for applying fare information for a transit organization\'s routes.',
		fields:[
		]
	},{
		id:'frequencies',
		required:false,
		details:'Headway (time between trips) for routes with variable frequency of service.',
		fields:[
		]
	},{
		id:'transfers',
		required:false,
		details:'Rules for making connections at transfer points between routes.',
		fields:[
		]
	},{
		id:'feed_info',
		required:false,
		details:'Additional information about the feed itself, including publisher, version, and expiration information.',
		fields:[
			{id:'feed_publisher_name',type:'string',required:true,details:'Contains the full name of the organization that publishes the feed. (This may be the same as one of the agency_name values in agency.txt.) GTFS-consuming applications can display this name when giving attribution for a particular feed\'s data.'},
			{id:'feed_publisher_url',type:'string',required:true,details:'Contains the URL of the feed publishing organization\'s website. (This may be the same as one of the agency_url values in agency.txt.) The value must be a fully qualified URL that includes http:// or https://, and any special characters in the URL must be correctly escaped.'},
			{id:'feed_lang',type:'string',required:true,details:'Contains a IETF BCP 47 language code specifying the default language used for the text in this feed. This setting helps GTFS consumers choose capitalization rules and other language-specific settings for the feed. For an introduction to IETF BCP 47, please refer to http://www.rfc-editor.org/rfc/bcp/bcp47.txt and http://www.w3.org/International/articles/language-tags/.'},
			{id:'feed_start_date',type:'date',required:false,details:'The feed provides complete and reliable schedule information for service in the period from the beginning of the feed_start_date day to the end of the feed_end_date day. Both days are given as dates in YYYYMMDD format as for calendar.txt, or left empty if unavailable.'},
			{id:'feed_end_date',type:'date',required:false,details:'The feed provides complete and reliable schedule information for service in the period from the beginning of the feed_start_date day to the end of the feed_end_date day. Both days are given as dates in YYYYMMDD format as for calendar.txt, or left empty if unavailable.'},
			{id:'feed_version',type:'string',required:false,details:'The feed publisher can specify a string here that indicates the current version of their GTFS feed. GTFS-consuming applications can display this value to help feed publishers determine whether the latest version of their feed has been incorporated.'},
		]
	}
])
formats.forEach(format => {
	format.fieldLookup = new Map();
	format.fields.forEach(f => {
		format.fieldLookup.set(f.id,f)

		f.parse = GetFormatParser(f.type, f.id);
	});
})

function GetFormatParser(f_type, f_name)
{
	var result;
	switch (f_type) {
		case 'string':/*case 'primary-key':case 'foreign-key':*/ result = (s,g) => s; break;
		case 'float':  result = (s,g) => parseFloat(s); break;
		case 'int':    result = (s,g) => parseInt(s,10); break;
		case 'date':   result = (s,g) => GTFSDate2days(s); break;
		case 'time':   result = (s,g) => parseTime(s); break;
		case 'primary-key':
			result = function(s,g){
				var id = g[f_name][s];
				if(id==undefined) {
					id = ++g[f_name+'N'];
					g[f_name][s] = id;
				}
				return id;
			}
			break;
		case 'foreign-key':
			result = function(s,g){
				var id = g[f_name][s];
				if(id==undefined) {
					console.log("unknown key for ",f_name,s);
				}
				return id;
			}
			break;
		default: throw console.error('Unknown field type "'+f_type+'"');
	}
	return result;
}

function ParseLine(line) {
	if (line.length <= 0) return false;
	if (line.indexOf('"') < 0) return line.split(',');

	var inQuotes = false, escape = false;
	var fields = [], field = '';
	for (var i = 0; i < line.length; i++) {
		var c = line[i];

		if (escape) {
			field += c;
			escape = false;
			continue;
		} else {
			escape = (c === '\\');
		}

		if ((c === ',') && !inQuotes) {
			fields.push(field);
			field = '';
			continue;
		}

		if (c === '"') {
			inQuotes = !inQuotes;
		} else {
			field += c;
		}
	}
	fields.push(field);
	return fields;
}

function parseTime(s) {
	s = s.split(':');
	return parseInt(s[0],10)*3600 + parseInt(s[1],10)*60 + parseInt(s[2],10)
}

function date2days(d) {
	d = (new Date(d)).getTime();
	d = (d-dayZero)/(86400000);
	return Math.round(d);
}
function days2date(d) {
	return new Date((d+1)*86400000+dayZero);
}
function days2string(d) {
	d = days2date(d);
	return d.toISOString().substring(0,10);
}

function GTFSDate2days(d) {
	return date2days(
		new Date(
			parseInt(d.substr(0,4),10),
			parseInt(d.substr(4,2),10)-1,
			parseInt(d.substr(6,2),10)
		)
	)
}

function binarySearch(sortedArray, elem, getKeyFunc) {
    let start = 0;
    let end = sortedArray.length - 1;
    while (start <= end) {
        let middle = Math.floor((start + end) / 2);
        if (getKeyFunc(sortedArray[middle]) === elem) { return middle; }
		else if (getKeyFunc(sortedArray[middle]) < elem) { start = middle + 1; }
		else { end = middle - 1; }
    }
    return start;
}
function getShapePoints(shape, minDist, maxDist)
{
	const startInd = binarySearch(shape, minDist, x=>x[0]);
	const endInd = binarySearch(shape, maxDist, x=>x[0]);
	return shape.slice(startInd, endInd+1).map(p => [p[1],p[2]]);
}
function humanReadableSize(bytes) {
  if (bytes == 0) { return "0.00 B"; }
  var e = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes/Math.pow(1024, e)).toFixed(2)+' '+' KMGTP'.charAt(e)+'B';
}

function getGtfsTime(timeMs, data) {
	var result = timeMs;
	result -= (new Date(data.start_date));
	result = result/1000 + (new Date().getTimezoneOffset())*-60;
	result -= data.day_diff * 86400;
	return result;
}
function gtfsTimeToDate(time, data) {
	time += data.day_diff * 86400;
	time -= (new Date().getTimezoneOffset())*-60;
	time *= 1000;
	time += (new Date(data.start_date)).getTime();
	return time;
}

function route(start, end, data, options={})
{
	const retMode = options.ret ?? 'route';
	var startTime = getGtfsTime(options.startTime ?? Date.now(), data);
				
	var performanceStart = new Date();
	var endTime = startTime+86400;
	
	if('lands' in data) {
		if(!('lands' in start)){
			if(('last' in data) && start.lon == data.last.start.lon && start.lat == data.last.start.lat && 'lands' in data.last.start) { start.lands=data.last.start.lands; }
			else { clusterStops([start], data.lands); }
		}
		if(!('lands' in end)){ clusterStops([end], data.lands); }
	}

	if(!('last' in data) || start.lon != data.last.start.lon || start.lat != data.last.start.lat || Math.floor(startTime/60) != Math.floor(data.last.startTime/60))
	{
		data.stops.forEach(function (stop) {
			stop.checked = false;
			
			var duration;
			[stop.startDistance, duration] = calcWalkDistDur(start, stop);
			[stop.endDistance, stop.endDuration] = calcWalkDistDur(end, stop);

			var time = startTime + duration + transferWait;
			stop.arr = {time:time, history:[{
				task:'walk',
				dstStop:stop,
				duration: duration,
				points: [[start.lon,start.lat], [stop.lon,stop.lat]], 
				color:'gray',
				start:startTime,
				end:startTime + duration
			}]}
		})

		while (true) {
			var checkStop = false, minTime = 1e10;
			data.stops.forEach(function (stop) {
				if (stop.checked) return;
				if (minTime > stop.arr.time) {
					minTime = stop.arr.time;
					checkStop = stop;
				}
			})
			if (!checkStop) break;

			checkStop.trips.forEach(function (entry) {
				var trip = entry[0];
				var index = entry[1];
				trip.dates.forEach(function (date) {
					var offset = date*86400;
					var depTime = offset + trip.stopDep[index];
					if (depTime > endTime) return;
					if (depTime < minTime) return;
					for (var i = index+1; i < trip.stopDep.length; i++) {
						var stop = trip.stops[i];
						var arrTime =  offset+trip.stopDep[i]+transferWait;
						if (arrTime < stop.arr.time) {
							stop.arr.time = arrTime;
							stop.arr.history = checkStop.arr.history.slice(0)
							stop.arr.history.push({
								task: 'wait',
								duration: (trip.stopDep[index]+offset) - checkStop.arr.time + transferWait,
							})
							var points = getShapePoints(data.shapes[trip.shape_id], trip.stopShapeDist[index], trip.stopShapeDist[i]);
							var stops = [];
							for (var j = index; j <= i; j++) stops.push([trip.stops[j].lon,trip.stops[j].lat]);
							stop.arr.history.push({
								dstStop:stop,
								route: trip.route,
								duration: trip.stopDep[i] - trip.stopDep[index],
								points:points,
								stops:stops,
								color:'#'+trip.route.color[0],
								start:trip.stopDep[index]+offset,
								end:  trip.stopDep[i]+offset,
							})
						}
					}
				})
			});
			checkStop.neighbours.forEach(function (neighbour) {
				const nStop = neighbour.stop;
				const walkTime = neighbour.dist/walkSpeed
				const arrTimeByWalk = minTime + walkTime;
				if(arrTimeByWalk < nStop.arr.time) {
					nStop.arr.time = arrTimeByWalk;
					nStop.arr.history = checkStop.arr.history.slice(0);
					nStop.arr.history.push({
						task:'walk',
						dstStop:nStop,
						duration: walkTime,
						points: [[checkStop.lon,checkStop.lat], [nStop.lon,nStop.lat]], 
						color:'gray',
						start:minTime,
						end:arrTimeByWalk
					});
				}
			});
			checkStop.checked = true;
		}
		data.last = {start:start, startTime:startTime};
	} else {
		data.stops.forEach(function (stop) {
			[stop.endDistance, stop.endDuration] = calcWalkDistDur(end, stop);
		});
	}

	var bestTime = 1e10, bestStop = false, bestLastStep = {};
	data.stops.forEach(function (stop) {
		const stopTotalTime = stop.arr.time + stop.endDuration;
		if (bestTime > stopTotalTime) {
			bestTime = stopTotalTime;
			bestStop = stop;
			bestLastStep = {
				task:'walk',
				duration:stop.endDuration,
				points:[[stop.lon,stop.lat], [end.lon,end.lat]],
				color:'gray',
				end:stopTotalTime
			}
		}
	})

	var performanceDuration = (new Date()) - performanceStart;
	if(retMode == 'duration'){
		return bestTime - startTime;
	}

	var html = [
		'<p>Found route in <b>'+performanceDuration+' ms</b></p>',
		'<table>'
	];
	var path = [];
	bestStop.arr.history.push(bestLastStep);
	
	bestStop.arr.history.forEach(function (step, si) {
		if('route' in step) {
			const srcStep = si>1 && 'dstStop' in bestStop.arr.history[si-1] ? bestStop.arr.history[si-1] : (si>1 && 'dstStop' in bestStop.arr.history[si-2] ? bestStop.arr.history[si-2] : null);
			if(srcStep && 'dstStop' in step) {
				const srcStop = srcStep.dstStop;
				const srcStartTime = srcStep.start;
				routeIds = collectSimilarRoutes(srcStop, step.dstStop, srcStartTime, [step.route._id]);
				routeIds.shift();
				step.altRoutes = routeIds.map(rid => [data.routes[rid].name, data.routes[rid].color]);
				step.altRoutes.sort((a,b)=> {
				  if (parseInt(a[0]) < parseInt(b[0])) return -1;
				  if (parseInt(a[0]) > parseInt(b[0])) return 1;
				  if (a[0] < b[0]) return -1;
				  if (a[0] > b[0]) return 1;
				  return 0;
				});
			}
			step.routeName = step.route.name;
			step.color = step.route.color;
			delete step.route;
		}
	});

	var bestRouteHistory = bestStop.arr.history.map(step => {return {...step}});
	bestStop.arr.history.pop();

	bestRouteHistory.forEach(function (step) {
		if('dstStop' in step && typeof step.dstStop === 'object') {
			step.dstStop = step.dstStop.name;
		}
		
		var duration = step.duration;
		duration = Math.ceil(duration/60).toFixed(0)+' Min';
		var startTime = step.start ? fmtTime(step.start) : '';
		var   endTime = step.end   ? fmtTime(step.end) : '';
		const stepText = (step.routeName ?? '')+(step.task ?? '')+(step.dstStop ? (' to '+step.dstStop) :'');
		html.push([
			'<tr><td>'+startTime+'</td><td>'+endTime+'</td><td class="text">'+stepText+'</td><td>'+duration+'</td></tr>'
		].join(''));
		console.log(startTime+' '+endTime+' '+stepText, duration);
		if (step.points) path.push({p:step.points, c:Array.isArray(step.color) ? '#'+step.color[0] : step.color||'black', s:step.stops||[], t:[startTime,endTime]});
	})
	html.push('</table>');
	html = html.join('');

	console.log(`routing took ${performanceDuration/1000} seconds`);
	
	function fmtTime(t) {
		t = t % 86400;
		var s = (t % 60).toFixed(0);
		t = Math.floor(t/60);
		var m = (t % 60).toFixed(0);
		t = Math.floor(t/60);
		var h = (t % 24).toFixed(0);
		return h+':'+('00'+m).slice(-2)
	}
	return {'path':path, 'steps':bestRouteHistory, 'perf_sec':performanceDuration/1000};
}

function collectSimilarRoutes(srcStop, dstStop, srcStartTime, routeIds)
{
	const lastDepTime = srcStartTime+30*60;
	for(const trip of srcStop.trips) {
		const tripDepTime = trip[0].stopDep[trip[1]];
		if(tripDepTime > srcStartTime && tripDepTime < lastDepTime && trip[0].stops.includes(dstStop, trip[1]) && !routeIds.includes(trip[0].route._id)) { routeIds.push(trip[0].route._id);}
		if(routeIds.length > 10) break;
	}
	return routeIds;
}

function compactArray(arr) {
	if(arr.length == 0){return {indToKey:[],data:[]};}
	
	const firstElem = arr[0];
	const firstElemKeys = Object.keys(firstElem)
	var indToKey = new Array(firstElemKeys.length);
	var keyToInd = {}
	var ind = 0;
	for (const key of firstElemKeys) {
		indToKey[ind]= key;
		keyToInd[key] = ind;
		ind++;
	}
	
	var newArr = [];
	arr.forEach(elem => {
		try{
		var newElem = new Array(indToKey.size);
		if(elem != null && elem.length != 0)
			for (const [key, value] of Object.entries(elem)) {
				newElem[keyToInd[key]] = value;
			}
		newArr.push(newElem);
		}catch(e) {
			console.log('compactArray problem with elem ',elem);
		}
	});
	
	return {indToKey:indToKey, keyToInd:keyToInd, data:newArr};
}

function expandArray(arr) {
	var result = [];
	arr.data.forEach(entry => {
		var obj = {};
		entry.forEach((e,i) => obj[arr.indToKey[i]] = e);
		result.push(obj);
	});
	return result;
}
function expandArrayTo(arr, target) {
	arr.data.forEach((entry,ti) => {
		entry.forEach((e,i) => target[ti][arr.indToKey[i]] = e);
	});
}

function initRoutes(common, day, dayNum)
{
	var routes = expandArray(common.routes);
	var stops = expandArray(common.stops);
	
	expandArrayTo(day.stops, stops);
	var services = expandArray(day.services);
	var trips = expandArray(day.trips);
	
	stops.forEach(s => {
		s.neighbours.forEach(ns => {
			ns.stop = stops[ns.s];
			delete ns.s;
		});
		s.trips.forEach(t => t[0] = trips[t[0]]);
		if('lands' in s && (typeof s.lands)=='string') s.lands = BigInt(s.lands);
	});
	trips.forEach(t => {
		t.route = routes[t.route];
		t.dates = services[t.service].dates;
		t.stops = t.stops.map(s => stops[s]);
	});
	var result = {
		day_diff: 0,
		start_date: days2string(dayNum),
		routes: routes,
		services: services,
		shapes: common.shapes,
		stops: stops,
		trips: trips,
		lands: [],
		stopMap: common.stopMap,
		routeMap: common.routeMap,
		tripMap: day.tripMap,
	};
	if('lands' in common) result.lands = common.lands; else delete result.lands;
	return result;
}

function sqr(v) { return v*v }
