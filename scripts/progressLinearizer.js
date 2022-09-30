
class ProgressLinearizer {
	constructor (title, db) {
		this.title = title;
		this.db = db;
		this.startTime = Date.now();
		this.lastProgressTime = this.startTime;
	}
	async load() {
		const tx = this.db.transaction('cache', 'readonly');
		const store = tx.objectStore('cache');
		const cachedObj = await store.get('progressMap');
		if(cachedObj !== undefined && cachedObj.data) {
			this.progressMap = cachedObj.data;
		}
		this.percentTimes=new Array(101).fill(0);
	}
	update(progress) {
		const nowMs = Date.now();
		var ind = Math.floor(progress*100);
		while(ind >= 0 && this.percentTimes[ind] == 0) {
			this.percentTimes[ind] = nowMs-this.startTime;
			ind--;
		}
		if(this.progressMap && progress < 1) {
			const percent = Math.floor(progress*100);
			const remainder = progress*100 - percent;
			progress = this.progressMap[percent]*(1-remainder) + this.progressMap[percent+1]*remainder;
		}
		if(nowMs - this.lastProgressTime > 300 || progress >= 1) {
			postMessage({'progress':[this.title, progress]});
			this.lastProgressTime = nowMs;
		}
		if(progress >= 1 && this.percentTimes && this.percentTimes[100]!=1) {
			const totalTime = nowMs-this.startTime;
			this.percentTimes = this.percentTimes.map(elem => elem / totalTime);
			this.percentTimes[100] = 1;
			
			const tx = db.transaction('cache', 'readwrite');
			const store = tx.objectStore('cache');
			const putPromise = store.put({name:'progressMap', data:this.percentTimes, date:new Date()});
		}
	}
}
