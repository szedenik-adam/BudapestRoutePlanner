"use strict"

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

	for (const format of formats) {
		var table = await loadGTFSFile(zip, format, db, me);
		if (table) data[format.id] = table;
	};
	var endTime = performance.now();
	console.log(`gtfs.zip parsing took ${(endTime - startTime)/1000} seconds`);
	
	var shapes = {};
	for (const point of data.shapes) {
		const sid = point.shape_id;
		delete point.shape_id;
		if(sid in shapes) shapes[sid].push(point);
		else shapes[sid]=[point];
	}
	for (const points of Object.values(shapes)) {
		points.sort((a, b) => { return a.shape_pt_sequence > b.shape_pt_sequence });
	}
	me.shapes = shapes;

	me.extract = function (startDate) {
		var startDay = date2days(startDate);
		var endDay   = startDay+7;

		// init routes
		var routes = new Map();
		data.routes.forEach(r => {
			routes.set(r.route_id, {
				name: r.route_short_name.length > 0 ? r.route_short_name : r.route_long_name,
				trips: []
			})
		})

		// init services
		var services = new Map();
		data.trips.forEach(t => {
			if (!services.has(t.service_id)) {
				services.set(t.service_id, {
					dates:new Set(),
					trips:[]
				});
			}
		})

		// init trips
		var trips = new Map();
		data.trips.forEach(t => {
			var route = routes.get(t.route_id);
			var service = services.get(t.service_id);
			var trip = {
				route:route,
				service:service,
				stops:[]
			}
			if(route == undefined) {
				console.log('undefined route', t.route_id);
			}
			route.trips.push(trip);
			service.trips.push(trip);
			trips.set(t.trip_id, trip);
		})

		// init stops
		var stops = new Map();
		data.stops.forEach(s => {
			stops.set(s.stop_id, {
				name:s.stop_name,
				lat:s.stop_lat,
				lon:s.stop_lon
			});
		});

		// init stop_times
		var stop_times = new Map();
		data.stop_times.forEach(st => {
			var trip = trips.get(st.trip_id);
			var stop = stops.get(st.stop_id);
			trip.stops[st.stop_sequence] = [st.arrival_time,st.departure_time,stop]
		})
		trips.forEach(t => {
			t.stops = t.stops.filter(s => s);
			t.stopArr = t.stops.map(s => s[0]);
			t.stopDep = t.stops.map(s => s[1]);
			t.stops   = t.stops.map(s => s[2]);
		})

		// now clean up
		if('calendar' in data) {data.calendar.forEach(c => { throw Error() });}

		data.calendar_dates.forEach(d => {
			if (d.date < startDay) return;
			if (d.date >   endDay) return;

			if (d.exception_type !== 1) throw Error();

			var service = services.get(d.service_id);
			if(!service){
				console.warn('service not found', d.service_id);
				return;
			}
			service.dates.add(d.date - startDay);
			service._use = true;
		})

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
		
		trips = Array.from(trips.values());
		trips = trips.filter(t => t._use);
		trips.forEach((t,i) => {
			t.route = t.route._index;
			t.service = t.service._index;
			t.stops = t.stops.map(s => s._index);
			delete t._use;
		});

		stops.forEach(s => (delete s._index, delete s._use));
		routes.forEach(r => (delete r._index, delete r._use));
		services.forEach(s => (delete s._index, delete s._use));
		
		stops.forEach(function (stop) {
			stop.trips = [];
			stop.tripCount = 0;
			
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
				stop.trips.push([trip,index]);
				stop.tripCount += trip.dates.length;
				return stop;
			});
		});

		var result = {
			start_date: startDate,
			stops: stops,//ao2oa(stops),
			routes: routes,//ao2oa(routes),
			services: services,//ao2oa(services),
			trips: trips,//ao2oa(trips),
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

	async function loadGTFSFile(zip, format, db, me) {
		try {
			var data = await zip.files[format.id+'.txt'].async("string");
			data = data.split(/[\r\n]/);
		} catch (e) {
			if (format.required) {
				console.error('missing '+format.id)
				throw e;
			} else {
				console.warn('missing '+format.id)
				return;
			}
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

		// parse keys
		var keys = ParseLine(data[0]);

		var missing = substractElements(format.fields.filter(f=>f.required).map(f=>f.id), keys);
		if (missing.length > 0) console.error('missing keys in "'+format.id+'": '+missing.join(', '))
		
		var unknown = substractElements(keys, format.fields.map(f=>f.id));
		//if (unknown.length > 0) console.error('unknown keys in "'+format.id+'": '+unknown.join(', '))
			
		if ((missing.length > 0) /*|| (unknown.length > 0)*/) throw new Error('check your GTFS!')

		var fields = keys.map(key => {
			var field = format.fieldLookup.get(key);
			//if (!field) throw Error();
			return field
		})

		var entries = [];
		for(var i=1; i<data.length; i++) {
			var line = data[i];
			if(!line) continue;
			var l = ParseLine(line);
			if (l.length != fields.length) throw Error();
			var obj = {};
			l.forEach((s,i) => {
				var f = fields[i];
				if(!f) {return;}
				obj[f.id] = f.parse(s, me);
			})
			entries.push(obj);
		}
		data = entries;

		console.log('imported '+data.length+' entries from '+format.id);

		return data;

		function substractElements(a1, a2) {
			a2 = new Set(a2);
			return a1.filter(k => !a2.has(k));
		}
	}
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
			{id:'shape_id',type:'string',required:false,details:'Identifies a geospatial shape that describes the vehicle travel path for a trip.'},
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
			{id:'shape_id',type:'string',required:false,details:'Contains an ID that defines a shape for the trip. This value is referenced from the shapes.txt file. The shapes.txt file allows you to define how a line should be drawn on the map to represent a trip.'},
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
			{id:'shape_dist_traveled',type:'string',required:false,details:'When used in the stop_times.txt file, this field positions a stop as a distance from the first shape point. The shape_dist_traveled field represents a real distance traveled along the route in units such as feet or kilometers. For example, if a bus travels a distance of 5.25 kilometers from the start of the shape to the stop, the shape_dist_traveled for the stop ID would be entered as "5.25".'},
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
		id:'shapes',
		required:false,
		details:'Rules for drawing lines on a map to represent a transit organization\'s routes.',
		fields:[
			{id:'shape_id',type:'string',required:true,details:'Identifies a shape.'},
			{id:'shape_pt_lat',type:'float',required:true,details:'Latitude of a shape point.'},
			{id:'shape_pt_lon',type:'float',required:true,details:'Longitude of a shape point.'},
			{id:'shape_pt_sequence',type:'int',required:true,details:'Sequence in which the shape points connect to form the shape. Values must increase along the trip but do not need to be consecutive.'},
			{id:'shape_dist_traveled',type:'float',required:false,details:'Actual distance traveled along the shape from the first shape point to the point specified in this record.'}
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

		switch (f.type) {
			case 'string':/*case 'primary-key':case 'foreign-key':*/ f.parse = (s,g) => s; break;
			case 'float':  f.parse = (s,g) => parseFloat(s); break;
			case 'int':    f.parse = (s,g) => parseInt(s,10); break;
			case 'date':   f.parse = (s,g) => GTFSDate2days(s); break;
			case 'time':   f.parse = (s,g) => parseTime(s); break;
			case 'primary-key':
				f.parse = function(s,g){
					var id = g[f.id][s];
					if(id==undefined) {
						id = ++g[f.id+'N'];
						g[f.id][s] = id;
					}
					return id;
				}
				break;
			case 'foreign-key':
				f.parse = function(s,g){
					var id = g[f.id][s];
					if(id==undefined) {
						console.log("unknown key for ",f.id,s);
					}
					return id;
				}
				break;
			default: throw console.error('Unknown field type "'+f.type+'"');
		}
	});
})

function parseTime(s) {
	s = s.split(':');
	return parseInt(s[0],10)*3600 + parseInt(s[1],10)*60 + parseInt(s[2],10)
}

function date2days(d) {
	d = (new Date(d)).getTime();
	d = (d-dayZero)/(86400000);
	return Math.round(d);
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

function route(start, end, data, startTime=null)
{
	if(!startTime){ startTime = Date.now(); }
	startTime -= (new Date(data.start_date));
	startTime = startTime/1000 + 2*3600;
	startTime = startTime % (86400*7); // quick fix, if only old data is available
				
	var performanceStart = new Date();
	var endTime = startTime+86400;

	data.stops.forEach(function (stop) {
		stop.arr = [];
		stop.checked = false;
	})

	//console.log(data);

	data.stops.forEach(function (stop) {
		stop.startDistance = Math.sqrt(sqr((start.lon-stop.lon)*71.6) + sqr((start.lat-stop.lat)*111.3));
		stop.endDistance   = Math.sqrt(sqr((  end.lon-stop.lon)*71.6) + sqr((  end.lat-stop.lat)*111.3));
		stop.endDuration   = stop.endDistance/walkSpeed;
		var duration = stop.startDistance/walkSpeed;

		var time = startTime + duration + transferWait;
		stop.arr = {time:time, history:[{
			text:'walk to '+stop.name,
			duration: duration,
			points: [[start.lon,start.lat], [stop.lon,stop.lat]],
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
				var offset = 0;//date*86400;
				var depTime = offset + trip.stopDep[index];
				if (depTime > endTime) return;
				if (depTime < minTime) return;
				for (var i = index+1; i < trip.stopDep.length; i++) {
					var stop = trip.stops[i];
					var arrTime =  offset+trip.stopArr[i]+transferWait;
					if (arrTime < stop.arr.time) {
						stop.arr.time = arrTime;
						stop.arr.history = checkStop.arr.history.slice(0)
						stop.arr.history.push({
							text: 'wait',
							duration: (trip.stopDep[index]+offset) - checkStop.arr.time + transferWait,
						})
						var points = [];
						for (var j = index; j <= i; j++) points.push([trip.stops[j].lon,trip.stops[j].lat]);
						stop.arr.history.push({
							text: trip.route.name+' to '+stop.name,
							duration: trip.stopArr[i] - trip.stopDep[index],
							points:points,
							start:trip.stopDep[index]+offset,
							end:  trip.stopArr[i]+offset,
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
					text:'walk to '+nStop.name,
					duration: walkTime,
					points: [[nStop.lon,nStop.lat]], 
					start:minTime,
					end:arrTimeByWalk
				});
			}
		});
		checkStop.checked = true;
	}

	var bestTime = 1e10, bestStop = false;
	data.stops.forEach(function (stop) {
		stop.arr.time += stop.endDuration;
		stop.arr.history.push({
			text:'walk to destination',
			duration:stop.endDuration,
			points:[[stop.lon,stop.lat], [end.lon,end.lat]],
			end:stop.arr.time
		});
		if (bestTime > stop.arr.time) {
			bestTime = stop.arr.time;
			bestStop = stop;
		}
	})

	var performanceDuration = (new Date()) - performanceStart;

	var html = [
		'<p>Found route in <b>'+performanceDuration+' ms</b></p>',
		'<table>'
	];
	var path = [];
	bestStop.arr.history.forEach(function (step) {
		var duration = step.duration;
		duration = Math.ceil(duration/60).toFixed(0)+' Min';
		var startTime = step.start ? fmtTime(step.start) : '';
		var   endTime = step.end   ? fmtTime(step.end) : '';
		html.push([
			'<tr><td>'+startTime+'</td><td>'+endTime+'</td><td class="text">'+step.text+'</td><td>'+duration+'</td></tr>'
		].join(''));
		console.log(startTime+' '+endTime+' '+step.text, duration);
		if (step.points) path = path.concat(step.points);
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
	return {'path':path, 'html':html};
}

function sqr(v) { return v*v }