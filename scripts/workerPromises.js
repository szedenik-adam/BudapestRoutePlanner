
class WorkerPromises {
	constructor (worker) {
		this.promiseResolvers = new Map();
		this.worker = worker;
		this.taskNum = 0;
	}
	processTask(task){
		var promiseResolve, promiseReject;
		var promise = new Promise(function(resolve, reject){
		  promiseResolve = resolve;
		  promiseReject = reject;
		});
		task['taskNum'] = this.taskNum;
		this.promiseResolvers.set(this.taskNum, promiseResolve);
		this.taskNum++;
		this.worker.postMessage(task);
		return promise;
	}
	checkMessageFromWorker(message){
		if('taskNum' in message) {
			const promiseResolve = this.promiseResolvers.get(message.taskNum);
			this.promiseResolvers.delete(message.taskNum);
			promiseResolve(message);
		}
	}
}