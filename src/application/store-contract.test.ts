import { InMemoryJobStore, InMemoryLogStore } from './testing';
import { describeJobStore, describeLogPaging, describeLogStore } from './store-contract';

/**
 * The fakes, against the contract the real stores are held to.
 *
 * Whatever this file proves, the workerd suite proves of Durable Object SQLite
 * with the same words. That is the point: a fake that behaves differently makes
 * every test above it a description of something that does not exist.
 */
describeJobStore('the in-memory store', async (use) => {
  await use(new InMemoryJobStore());
});

describeLogStore('the in-memory store', async (use) => {
  await use(new InMemoryLogStore());
});

describeLogPaging('the in-memory store', async (use) => {
  await use(new InMemoryLogStore());
});
