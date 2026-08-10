import type { ArtifactStore } from '../../application/ports';

/**
 * Patch and result bodies, in R2.
 *
 * They live outside the job record because neither has a size bound, and a
 * Durable Object's storage is the wrong place for a megabyte of diff.
 */
export class R2ArtifactStore implements ArtifactStore {
  constructor(private readonly bucket: R2Bucket) {}

  async putPatch(jobId: string, patch: string): Promise<void> {
    await this.bucket.put(key(jobId, 'patch.diff'), patch);
  }

  async putResult(jobId: string, body: string): Promise<void> {
    await this.bucket.put(key(jobId, 'result.json'), body);
  }

  async getPatch(jobId: string): Promise<string | null> {
    const object = await this.bucket.get(key(jobId, 'patch.diff'));
    return object ? object.text() : null;
  }
}

function key(jobId: string, name: string): string {
  return `jobs/${jobId}/${name}`;
}
