import * as z from 'zod/v4';

/** Stateless handles. A timeline id is the hash of an immutable timeline document. */
export const TimelineId = z
  .string()
  .regex(/^tl_[0-9a-f]{32}$/)
  .describe('Timeline handle; every edit returns a new one');
export const MediaId = z
  .string()
  .regex(/^m_[0-9a-z]{26}$/)
  .describe('Media handle from media.import or a create.* tool');
export const UploadId = z
  .string()
  .regex(/^u_[0-9a-z]{26}$/)
  .describe('Upload handle from media.upload');
export const JobId = z
  .string()
  .regex(/^j_[0-9a-z]{26}$/)
  .describe('Job handle; the same value is the MCP task id');
