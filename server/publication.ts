/** Batches hints while giving each caller an acknowledgement for its own batch. */
export class CoalescedPublisher {
  private ids = new Set<string>();
  private waiters: { resolve: () => void; reject: (error: unknown) => void }[] =
    [];
  private running = false;
  constructor(
    private dispatch: (ids: string[]) => Promise<void>,
    private delay = 50,
  ) {}
  publish(id: string) {
    this.ids.add(id);
    const done = new Promise<void>((resolve, reject) =>
      this.waiters.push({ resolve, reject }),
    );
    this.schedule();
    return done;
  }
  private schedule() {
    if (this.running) return;
    this.running = true;
    setTimeout(() => void this.flush(), this.delay);
  }
  private async flush() {
    const ids = [...this.ids],
      waiters = this.waiters;
    this.ids.clear();
    this.waiters = [];
    try {
      await this.dispatch(ids);
      for (const w of waiters) w.resolve();
    } catch (error) {
      for (const w of waiters) w.reject(error);
    } finally {
      this.running = false;
      if (this.ids.size) this.schedule();
    }
  }
}
