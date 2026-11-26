/** True once the worker is stopping: a loop finishes its current item and takes no new one. */
export type Stopping = () => boolean;

/** Never stopping: for one-off runs and tests. */
export const neverStopping: Stopping = () => false;
