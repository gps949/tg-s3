import { encodeXml } from '../utils/path';
import type { BucketRow, ObjectRow, MultipartPartRow, MultipartUploadRow } from '../types';

const XML_HEAD = '<?xml version="1.0" encoding="UTF-8"?>';
const NS = 'http://s3.amazonaws.com/doc/2006-03-01/';
const OWNER_XML = '<Owner><ID>tg-s3</ID><DisplayName>tg-s3</DisplayName></Owner>';

// Encode a value for XML, optionally URL-encoding first (for encoding-type=url)
function enc(value: string, urlEncode?: boolean): string {
  return encodeXml(urlEncode ? encodeURIComponent(value) : value);
}

// Encode ETag for XML element content: only escape &, <, > but NOT quotes.
// AWS S3 outputs literal double-quote characters in ETag element content (e.g. <ETag>"abc"</ETag>).
// XML spec allows unescaped quotes in element content; using &quot; can break lightweight S3 clients.
function encEtag(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function errorXml(code: string, message: string, resource?: string, requestId?: string, hostId?: string, retryAfterSeconds?: number): string {
  return `${XML_HEAD}\n<Error><Code>${code}</Code><Message>${encodeXml(message)}</Message>${resource ? `<Resource>${encodeXml(resource)}</Resource>` : ''}${requestId ? `<RequestId>${requestId}</RequestId>` : ''}${hostId ? `<HostId>${hostId}</HostId>` : ''}${retryAfterSeconds !== undefined ? `<RetryAfterSeconds>${retryAfterSeconds}</RetryAfterSeconds>` : ''}</Error>`;
}

export function listBucketsXml(buckets: BucketRow[]): string {
  const items = buckets.map(b =>
    `<Bucket><Name>${encodeXml(b.name)}</Name><CreationDate>${b.created_at}</CreationDate></Bucket>`
  ).join('');
  return `${XML_HEAD}\n<ListAllMyBucketsResult xmlns="${NS}">${OWNER_XML}<Buckets>${items}</Buckets></ListAllMyBucketsResult>`;
}

export function listObjectsV2Xml(p: {
  bucket: string; prefix: string; delimiter: string; maxKeys: number;
  startAfter?: string; continuationToken?: string;
  contents: ObjectRow[]; commonPrefixes: string[];
  isTruncated: boolean; nextToken?: string; keyCount: number;
  encodingType?: string; fetchOwner?: boolean;
}): string {
  const u = p.encodingType === 'url';
  const owner = p.fetchOwner ? OWNER_XML : '';
  const contents = p.contents.map(o => `<Contents><Key>${enc(o.key, u)}</Key><LastModified>${o.last_modified}</LastModified><ETag>${encEtag(o.etag)}</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass>${owner}</Contents>`).join('');
  const prefixes = p.commonPrefixes.map(cp => `<CommonPrefixes><Prefix>${enc(cp, u)}</Prefix></CommonPrefixes>`).join('');
  const etEl = u ? '<EncodingType>url</EncodingType>' : '';
  const delimEl = p.delimiter ? `<Delimiter>${enc(p.delimiter, u)}</Delimiter>` : '';
  return `${XML_HEAD}\n<ListBucketResult xmlns="${NS}"><Name>${encodeXml(p.bucket)}</Name><Prefix>${enc(p.prefix, u)}</Prefix>${delimEl}<MaxKeys>${p.maxKeys}</MaxKeys><KeyCount>${p.keyCount}</KeyCount>${etEl}<IsTruncated>${p.isTruncated}</IsTruncated>${p.continuationToken ? `<ContinuationToken>${encodeXml(p.continuationToken)}</ContinuationToken>` : ''}${p.nextToken ? `<NextContinuationToken>${encodeXml(p.nextToken)}</NextContinuationToken>` : ''}${p.startAfter ? `<StartAfter>${enc(p.startAfter, u)}</StartAfter>` : ''}${contents}${prefixes}</ListBucketResult>`;
}

export function listObjectsV1Xml(p: {
  bucket: string; prefix: string; delimiter: string; maxKeys: number;
  marker?: string;
  contents: ObjectRow[]; commonPrefixes: string[];
  isTruncated: boolean; nextMarker?: string;
  encodingType?: string;
}): string {
  const u = p.encodingType === 'url';
  const contents = p.contents.map(o => `<Contents><Key>${enc(o.key, u)}</Key><LastModified>${o.last_modified}</LastModified><ETag>${encEtag(o.etag)}</ETag><Size>${o.size}</Size><StorageClass>STANDARD</StorageClass>${OWNER_XML}</Contents>`).join('');
  const prefixes = p.commonPrefixes.map(cp => `<CommonPrefixes><Prefix>${enc(cp, u)}</Prefix></CommonPrefixes>`).join('');
  const etEl = u ? '<EncodingType>url</EncodingType>' : '';
  const delimEl = p.delimiter ? `<Delimiter>${enc(p.delimiter, u)}</Delimiter>` : '';
  return `${XML_HEAD}\n<ListBucketResult xmlns="${NS}"><Name>${encodeXml(p.bucket)}</Name><Prefix>${enc(p.prefix, u)}</Prefix><Marker>${p.marker ? enc(p.marker, u) : ''}</Marker>${delimEl}<MaxKeys>${p.maxKeys}</MaxKeys>${etEl}<IsTruncated>${p.isTruncated}</IsTruncated>${p.nextMarker ? `<NextMarker>${enc(p.nextMarker, u)}</NextMarker>` : ''}${contents}${prefixes}</ListBucketResult>`;
}

export function copyObjectXml(etag: string, lastModified: string): string {
  return `${XML_HEAD}\n<CopyObjectResult xmlns="${NS}"><ETag>${encEtag(etag)}</ETag><LastModified>${lastModified}</LastModified></CopyObjectResult>`;
}

export function copyPartResultXml(etag: string, lastModified: string): string {
  return `${XML_HEAD}\n<CopyPartResult xmlns="${NS}"><ETag>${encEtag(etag)}</ETag><LastModified>${lastModified}</LastModified></CopyPartResult>`;
}

export function deleteObjectsXml(deleted: string[], errors: Array<{ key: string; code: string; message: string }>): string {
  const d = deleted.map(k => `<Deleted><Key>${encodeXml(k)}</Key></Deleted>`).join('');
  const e = errors.map(err => `<Error><Key>${encodeXml(err.key)}</Key><Code>${err.code}</Code><Message>${encodeXml(err.message)}</Message></Error>`).join('');
  return `${XML_HEAD}\n<DeleteResult xmlns="${NS}">${d}${e}</DeleteResult>`;
}

export function initiateMultipartXml(bucket: string, key: string, uploadId: string): string {
  return `${XML_HEAD}\n<InitiateMultipartUploadResult xmlns="${NS}"><Bucket>${encodeXml(bucket)}</Bucket><Key>${encodeXml(key)}</Key><UploadId>${encodeXml(uploadId)}</UploadId></InitiateMultipartUploadResult>`;
}

export function completeMultipartXml(bucket: string, key: string, etag: string, location?: string): string {
  return `${XML_HEAD}\n<CompleteMultipartUploadResult xmlns="${NS}">${location ? `<Location>${encodeXml(location)}</Location>` : ''}<Bucket>${encodeXml(bucket)}</Bucket><Key>${encodeXml(key)}</Key><ETag>${encEtag(etag)}</ETag></CompleteMultipartUploadResult>`;
}

export function listPartsXml(bucket: string, key: string, uploadId: string, parts: MultipartPartRow[], isTruncated = false, nextPartNumberMarker?: number, maxParts = 1000, partNumberMarker = 0): string {
  const p = parts.map(pt => {
    const lm = pt.created_at ? `<LastModified>${pt.created_at}</LastModified>` : '';
    return `<Part><PartNumber>${pt.part_number}</PartNumber>${lm}<ETag>${encEtag(pt.etag)}</ETag><Size>${pt.size}</Size></Part>`;
  }).join('');
  return `${XML_HEAD}\n<ListPartsResult xmlns="${NS}"><Bucket>${encodeXml(bucket)}</Bucket><Key>${encodeXml(key)}</Key><UploadId>${encodeXml(uploadId)}</UploadId><Initiator><ID>tg-s3</ID><DisplayName>tg-s3</DisplayName></Initiator>${OWNER_XML}<StorageClass>STANDARD</StorageClass><PartNumberMarker>${partNumberMarker}</PartNumberMarker><MaxParts>${maxParts}</MaxParts><IsTruncated>${isTruncated}</IsTruncated>${nextPartNumberMarker !== undefined ? `<NextPartNumberMarker>${nextPartNumberMarker}</NextPartNumberMarker>` : ''}${p}</ListPartsResult>`;
}

export function listMultipartUploadsXml(p: {
  bucket: string; prefix: string; delimiter?: string; keyMarker: string; uploadIdMarker: string;
  maxUploads: number; isTruncated: boolean; uploads: MultipartUploadRow[];
  commonPrefixes?: string[];
  nextKeyMarker?: string; nextUploadIdMarker?: string;
  encodingType?: string;
}): string {
  const u = p.encodingType === 'url';
  const items = p.uploads.map(up =>
    `<Upload><Key>${enc(up.key, u)}</Key><UploadId>${encodeXml(up.upload_id)}</UploadId><Initiator><ID>tg-s3</ID><DisplayName>tg-s3</DisplayName></Initiator>${OWNER_XML}<StorageClass>STANDARD</StorageClass><Initiated>${up.created_at}</Initiated></Upload>`
  ).join('');
  const prefixes = (p.commonPrefixes || []).map(cp => `<CommonPrefixes><Prefix>${enc(cp, u)}</Prefix></CommonPrefixes>`).join('');
  const etEl = u ? '<EncodingType>url</EncodingType>' : '';
  const delimEl = p.delimiter ? `<Delimiter>${enc(p.delimiter, u)}</Delimiter>` : '';
  return `${XML_HEAD}\n<ListMultipartUploadsResult xmlns="${NS}"><Bucket>${encodeXml(p.bucket)}</Bucket><KeyMarker>${enc(p.keyMarker, u)}</KeyMarker><UploadIdMarker>${encodeXml(p.uploadIdMarker)}</UploadIdMarker><Prefix>${enc(p.prefix, u)}</Prefix>${delimEl}<MaxUploads>${p.maxUploads}</MaxUploads>${etEl}<IsTruncated>${p.isTruncated}</IsTruncated>${p.nextKeyMarker ? `<NextKeyMarker>${enc(p.nextKeyMarker, u)}</NextKeyMarker>` : ''}${p.nextUploadIdMarker ? `<NextUploadIdMarker>${encodeXml(p.nextUploadIdMarker)}</NextUploadIdMarker>` : ''}${items}${prefixes}</ListMultipartUploadsResult>`;
}

export function xmlResponse(body: string, status = 200): Response {
  return new Response(body, { status, headers: { 'Content-Type': 'application/xml' } });
}

export function errorResponse(status: number, code: string, message: string, resource?: string, retryAfterSeconds?: number): Response {
  const genId = () => Array.from(crypto.getRandomValues(new Uint8Array(8))).map(b => b.toString(16).padStart(2, '0')).join('').toUpperCase();
  const requestId = genId();
  const hostId = genId() + genId();
  const headers: Record<string, string> = {
    'Content-Type': 'application/xml',
    'x-amz-request-id': requestId,
    'x-amz-id-2': hostId,
    // AWS SDKs read these headers for HEAD error responses (where body is stripped)
    'x-amz-error-code': code,
    'x-amz-error-message': message,
  };
  if (retryAfterSeconds !== undefined) {
    headers['Retry-After'] = retryAfterSeconds.toString();
  }
  return new Response(errorXml(code, message, resource, requestId, hostId, retryAfterSeconds), {
    status,
    headers,
  });
}
