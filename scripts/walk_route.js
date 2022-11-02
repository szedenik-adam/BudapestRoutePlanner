 
function calcWalkDistDur(a, b)
{
	var dist = Math.sqrt(sqr((a.lon-b.lon)*71.6) + sqr((a.lat-b.lat)*111.3));
	var dur = dist / walkSpeed;
	return [dist, dur];
}