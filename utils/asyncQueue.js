/**
 * Limits how many async tasks run at the same time.
 * Useful for yt-dlp downloads and other heavy work on busy servers.
 */
class AsyncQueue {
    constructor(concurrency = 2) {
        this.concurrency = Math.max(1, concurrency);
        this.running = 0;
        this.queue = [];
    }

    get pending() {
        return this.queue.length;
    }

    get active() {
        return this.running;
    }

    run(task) {
        return new Promise((resolve, reject) => {
            this.queue.push({ task, resolve, reject });
            this.#drain();
        });
    }

    #drain() {
        while (this.running < this.concurrency && this.queue.length > 0) {
            const { task, resolve, reject } = this.queue.shift();
            this.running += 1;
            Promise.resolve()
                .then(task)
                .then(resolve, reject)
                .finally(() => {
                    this.running -= 1;
                    this.#drain();
                });
        }
    }
}

module.exports = { AsyncQueue };
