 
function calcWalkDistDur(a, b)
{
	var dist = Math.sqrt(sqr((a.lon-b.lon)*71.6) + sqr((a.lat-b.lat)*111.3));
	var dur = dist / walkSpeed;

	if('lands' in a && 'lands' in b) {
		if(!(a.lands & b.lands)) dur *= 100;
	}

	return [dist, dur];
}

function clusterStops(stops, lands)
{
	stops.forEach(stop => {
		var point = turf.point([stop.lon, stop.lat]);
		var linds = BigInt(0)
		lands.forEach((land,li) => {
			if(turf.booleanWithin(point, land)) linds|= BigInt(1)<<BigInt(li);
		});
		stop.lands = linds;
	});
}