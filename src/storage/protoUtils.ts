/**
 * Low-level Protocol Buffer (Protobuf) wire format encoder and parser
 * for Antigravity Unified State Sync and UserStatus payload manipulation.
 */

export function encodeVarint(val: number): Uint8Array {
  const bytes: number[] = [];
  let num = BigInt(val);
  while (num >= 128n) {
    bytes.push(Number((num & 127n) | 128n));
    num >>= 7n;
  }
  bytes.push(Number(num));
  return new Uint8Array(bytes);
}

export function encodeVarintField(fieldNum: number, value: number): Uint8Array {
  const tag = (fieldNum << 3) | 0;
  const tagBytes = encodeVarint(tag);
  const valueBytes = encodeVarint(value);
  return Buffer.concat([Buffer.from(tagBytes), Buffer.from(valueBytes)]);
}

export function encodeLenDelimField(fieldNum: number, data: Uint8Array): Uint8Array {
  const tag = (fieldNum << 3) | 2;
  const tagBytes = encodeVarint(tag);
  const lenBytes = encodeVarint(data.length);
  return Buffer.concat([Buffer.from(tagBytes), Buffer.from(lenBytes), Buffer.from(data)]);
}

export function encodeStringField(fieldNum: number, value: string): Uint8Array {
  return encodeLenDelimField(fieldNum, Buffer.from(value, 'utf8'));
}

export function createOAuthInfo(
  accessToken: string,
  refreshToken: string,
  expirySeconds: number,
  isGcpTos = false,
  idToken?: string,
  email?: string
): Uint8Array {
  if (isGcpTos && email) {
    const lower = email.toLowerCase();
    if (lower.endsWith('@gmail.com') || lower.endsWith('@googlemail.com')) {
      isGcpTos = false;
    }
  }

  const field1 = encodeStringField(1, accessToken);
  const field2 = encodeStringField(2, 'Bearer');
  const field3 = encodeStringField(3, refreshToken);

  const timestampTag = (1 << 3) | 0;
  const tagBytes = encodeVarint(timestampTag);
  const secondsBytes = encodeVarint(expirySeconds);
  const timestampMsg = Buffer.concat([Buffer.from(tagBytes), Buffer.from(secondsBytes)]);
  const field4 = encodeLenDelimField(4, timestampMsg);

  const field5 = idToken ? encodeStringField(5, idToken) : new Uint8Array();
  const field6 = isGcpTos ? encodeVarintField(6, 1) : new Uint8Array();

  return Buffer.concat([
    Buffer.from(field1),
    Buffer.from(field2),
    Buffer.from(field3),
    Buffer.from(field4),
    Buffer.from(field5),
    Buffer.from(field6)
  ]);
}

export function parseProtoFields(buf: Uint8Array): Array<{ fieldNum: number; wireType: number; data: bigint | Uint8Array; rawBytes: Uint8Array }> {
  let pos = 0;
  const fields: Array<{ fieldNum: number; wireType: number; data: bigint | Uint8Array; rawBytes: Uint8Array }> = [];
  while (pos < buf.length) {
    const tagStart = pos;
    let tag = 0;
    let shift = 0;
    while (pos < buf.length) {
      const b = buf[pos++];
      tag |= (b & 0x7F) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    const wireType = tag & 7;
    const fieldNum = tag >> 3;
    let data: bigint | Uint8Array = 0n;

    if (wireType === 0) {
      let val = 0n;
      let valShift = 0n;
      while (pos < buf.length) {
        const b = buf[pos++];
        val |= BigInt(b & 0x7F) << valShift;
        valShift += 7n;
        if ((b & 0x80) === 0) break;
      }
      data = val;
    } else if (wireType === 2) {
      let len = 0;
      let lenShift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7F) << lenShift;
        lenShift += 7;
        if ((b & 0x80) === 0) break;
      }
      data = buf.subarray(pos, pos + len);
      pos += len;
    } else if (wireType === 1) {
      data = buf.subarray(pos, pos + 8);
      pos += 8;
    } else if (wireType === 5) {
      data = buf.subarray(pos, pos + 4);
      pos += 4;
    } else {
      break;
    }
    fields.push({ fieldNum, wireType, data, rawBytes: buf.subarray(tagStart, pos) });
  }
  return fields;
}

export function patchUserStatusPayload(existingBytes: Uint8Array, newEmail: string, newName?: string, newAvatarUrl?: string): Uint8Array {
  const fields = parseProtoFields(existingBytes);
  const resultParts: Uint8Array[] = [];
  let hasEmail = false;
  let hasName = false;
  let hasAvatar = false;

  for (const f of fields) {
    if (f.fieldNum === 7) {
      resultParts.push(encodeStringField(7, newEmail));
      hasEmail = true;
    } else if (f.fieldNum === 3) {
      resultParts.push(encodeStringField(3, newName || newEmail.split('@')[0]));
      hasName = true;
    } else if (f.fieldNum === 26) {
      if (newAvatarUrl) {
        resultParts.push(encodeStringField(26, newAvatarUrl));
      } else if (f.wireType === 2 && f.data instanceof Uint8Array) {
        resultParts.push(encodeStringField(26, Buffer.from(f.data).toString('utf8')));
      }
      hasAvatar = true;
    } else {
      // PRESERVE ALL OTHER FIELDS (including models, paid tier, permissions, etc.)
      resultParts.push(f.rawBytes);
    }
  }

  if (!hasEmail) {
    resultParts.push(encodeStringField(7, newEmail));
  }
  if (!hasName) {
    resultParts.push(encodeStringField(3, newName || newEmail.split('@')[0]));
  }
  if (!hasAvatar && newAvatarUrl) {
    resultParts.push(encodeStringField(26, newAvatarUrl));
  }

  return Buffer.concat(resultParts.map(p => Buffer.from(p)));
}

export function patchUnifiedStateSyncTopicUserStatus(
  topicBuf: Uint8Array,
  newEmail: string,
  newName?: string,
  newAvatarUrl?: string
): string | null {
  try {
    const topFields = parseProtoFields(topicBuf);
    const newEntries: Uint8Array[] = [];
    let found = false;

    for (const f of topFields) {
      if (f.fieldNum === 1 && f.wireType === 2 && f.data instanceof Uint8Array) {
        const entryFields = parseProtoFields(f.data);
        const keyField = entryFields.find(e => e.fieldNum === 1);
        const key = keyField && keyField.data instanceof Uint8Array ? Buffer.from(keyField.data).toString('utf8') : '';

        if (key === 'userStatusSentinelKey') {
          const rowField = entryFields.find(e => e.fieldNum === 2);
          if (rowField && rowField.data instanceof Uint8Array) {
            const rowFields = parseProtoFields(rowField.data);
            const valField = rowFields.find(r => r.fieldNum === 1);
            if (valField && valField.data instanceof Uint8Array) {
              const innerB64 = Buffer.from(valField.data).toString('utf8');
              const innerBytes = Buffer.from(innerB64, 'base64');
              const patchedBytes = patchUserStatusPayload(innerBytes, newEmail, newName, newAvatarUrl);
              const patchedB64 = Buffer.from(patchedBytes).toString('base64');
              const newRow = encodeStringField(1, patchedB64);
              const newEntry = Buffer.concat([
                Buffer.from(encodeStringField(1, 'userStatusSentinelKey')),
                Buffer.from(encodeLenDelimField(2, newRow))
              ]);
              newEntries.push(encodeLenDelimField(1, newEntry));
              found = true;
              continue;
            }
          }
        }
        newEntries.push(encodeLenDelimField(1, f.data));
      }
    }

    if (found) {
      return Buffer.concat(newEntries.map(e => Buffer.from(e))).toString('base64');
    }
  } catch (e) {
    console.warn('[Antigravity Swap] patchUnifiedStateSyncTopicUserStatus error:', e);
  }
  return null;
}

export function createDataEntry(sentinelKey: string, valueStr: string): Uint8Array {
  const row = encodeStringField(1, valueStr);
  return Buffer.concat([
    Buffer.from(encodeStringField(1, sentinelKey)),
    Buffer.from(encodeLenDelimField(2, row))
  ]);
}

export function createUnifiedStateEntry(sentinelKey: string, payload: Uint8Array): string {
  const payloadBase64 = Buffer.from(payload).toString('base64');
  const dataEntry = createDataEntry(sentinelKey, payloadBase64);
  const topic = encodeLenDelimField(1, dataEntry);
  return Buffer.from(topic).toString('base64');
}

export function createUnifiedOAuthToken(
  accessToken: string,
  refreshToken: string,
  expirySeconds: number,
  isGcpTos = false,
  idToken?: string,
  email?: string
): string {
  if (isGcpTos && email) {
    const lower = email.toLowerCase();
    if (lower.endsWith('@gmail.com') || lower.endsWith('@googlemail.com')) {
      isGcpTos = false;
    }
  }
  const oauthInfo = createOAuthInfo(accessToken, refreshToken, expirySeconds, isGcpTos, idToken, email);
  const oauthB64 = Buffer.from(oauthInfo).toString('base64');
  const entry1 = createDataEntry('oauthTokenInfoSentinelKey', oauthB64);

  const authStateJson = JSON.stringify({
    state: 'signedIn',
    context: {
      project: '',
      showProjectError: false,
      errorMessage: '',
      ineligibleMessage: '',
      verificationUrl: '',
      isGcpTos: isGcpTos,
      browserOpenFailed: false,
      appealUrl: '',
      appealLinkText: ''
    }
  });
  const entry2 = createDataEntry('authStateWithContextSentinelKey', authStateJson);

  const topicMsg = Buffer.concat([
    Buffer.from(encodeLenDelimField(1, entry1)),
    Buffer.from(encodeLenDelimField(1, entry2))
  ]);
  return Buffer.from(topicMsg).toString('base64');
}

export function createUserStatusPayload(email: string, name?: string): Uint8Array {
  const field1 = encodeVarintField(1, 1); // pro: true
  const field3 = encodeStringField(3, name || email.split('@')[0]); // name
  const field7 = encodeStringField(7, email); // email
  const field31 = encodeVarintField(31, 1); // has_used_antigravity: true
  const field34 = encodeVarintField(34, 1); // accepted_latest_terms_of_service: true
  return Buffer.concat([
    Buffer.from(field1),
    Buffer.from(field3),
    Buffer.from(field7),
    Buffer.from(field31),
    Buffer.from(field34)
  ]);
}

export function createUnifiedUserStatus(email: string, name?: string): string {
  const userStatusPayload = createUserStatusPayload(email, name);
  return createUnifiedStateEntry('userStatusSentinelKey', userStatusPayload);
}

export function createSerializedUpdateRequest(topicName: string, sentinelKey: string, innerPayloadBytes: Uint8Array): string {
  const innerBase64 = Buffer.from(innerPayloadBytes).toString('base64');
  const rowMsg = encodeStringField(1, innerBase64);
  const appliedUpdateMsg = Buffer.concat([
    Buffer.from(encodeStringField(1, sentinelKey)),
    Buffer.from(encodeLenDelimField(2, rowMsg))
  ]);
  const updateRequestMsg = Buffer.concat([
    Buffer.from(encodeStringField(1, topicName)),
    Buffer.from(encodeLenDelimField(5, appliedUpdateMsg))
  ]);
  return Buffer.from(updateRequestMsg).toString('base64');
}

export function parseUserStatusBytes(bytes: Uint8Array): { email: string; name: string } {
  let email = '';
  let name = '';
  let pos = 0;
  while (pos < bytes.length) {
    let tag = 0;
    let shift = 0;
    while (pos < bytes.length) {
      const b = bytes[pos++];
      tag |= (b & 0x7F) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    const wireType = tag & 7;
    const fieldNum = tag >> 3;

    if (wireType === 0) {
      while (pos < bytes.length && (bytes[pos++] & 0x80) !== 0) {}
    } else if (wireType === 2) {
      let len = 0;
      let lenShift = 0;
      while (pos < bytes.length) {
        const b = bytes[pos++];
        len |= (b & 0x7F) << lenShift;
        lenShift += 7;
        if ((b & 0x80) === 0) break;
      }
      if (pos + len <= bytes.length) {
        const strBytes = bytes.subarray(pos, pos + len);
        if (fieldNum === 7) {
          email = Buffer.from(strBytes).toString('utf8');
        } else if (fieldNum === 3) {
          name = Buffer.from(strBytes).toString('utf8');
        }
      }
      pos += len;
    } else if (wireType === 1) {
      pos += 8;
    } else if (wireType === 5) {
      pos += 4;
    } else {
      break;
    }
  }
  return { email, name };
}
