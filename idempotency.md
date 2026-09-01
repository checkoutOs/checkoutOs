Idempotency Implementation Plan
Option A (Pure Service Layer)
Following checkoutOs Handbook Rules Strictly
Version 1.0 - Production Ready
Technical Implementation Document
April 14, 2026
Contents
1 Executive Summary 3
1.1 Document Purpose . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . 3
1.2 What This Plan Covers . . . . . . . . . . . . . . . . . . . . . . . . . . . . 3
1.3 Fixed Issues Summary . . . . . . . . . . . . . . . . . . . . . . . . . . . . 3
1.4 Success Criteria . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . 3
2 Architecture Overview 5
2.1 High-Level Flow Diagram . . . . . . . . . . . . . . . . . . . . . . . . . . 5
2.2 Layer Responsibilities Matrix . . . . . . . . . . . . . . . . . . . . . . . . 6
3 Types Layer (Foundation) 7
3.1 Step 1.1: Add Idempotency Types to common.types.ts . . . . . . . . . . 7
3.2 Step 1.2: Create Express Type Extension . . . . . . . . . . . . . . . . . . 7
3.3 Step 1.3: Create Idempotency Error Types . . . . . . . . . . . . . . . . . 8
3.4 Step 1.4: Create OrderId Mismatch Errors . . . . . . . . . . . . . . . . . 9
3.5 Step 1.5: Import Pattern Verification . . . . . . . . . . . . . . . . . . . . 10
4 Store Layer 11
4.1 Step 2.1: Create Idempotency Store . . . . . . . . . . . . . . . . . . . . . 11
4.2 Step 2.2: Verify Redis Client Exists . . . . . . . . . . . . . . . . . . . . . 13
5 Service Layer 14
5.1 Step 3.1: Create Idempotency Service . . . . . . . . . . . . . . . . . . . . 14
5.2 Step 3.2: Modify Payment Service . . . . . . . . . . . . . . . . . . . . . . 18
1
Idempotency Implementation Plan checkoutOs V1.0
6 Middleware Layer 22
6.1 Step 4.1: Create Idempotency Middleware . . . . . . . . . . . . . . . . . 22
7 Controller Layer 24
7.1 Step 5.1: Modify Payment Controller . . . . . . . . . . . . . . . . . . . . 24
8 Routes/Middleware Registration 26
8.1 Step 6.1: Register Middleware on Route . . . . . . . . . . . . . . . . . . 26
9 Utility Functions 27
9.1 Step 7.1: Verify Time Utility Exists . . . . . . . . . . . . . . . . . . . . . 27
9.2 Step 7.2: Create Hash Utility (Optional) . . . . . . . . . . . . . . . . . . 27
10 Testing 28
10.1 Step 8.1: Store Layer Unit Tests . . . . . . . . . . . . . . . . . . . . . . . 28
10.2 Step 8.2: Service Layer Unit Tests . . . . . . . . . . . . . . . . . . . . . . 30
10.3 Step 8.3: Stale IN PROGRESS Tests . . . . . . . . . . . . . . . . . . . . 32
10.4 Step 8.4: Integration Tests . . . . . . . . . . . . . . . . . . . . . . . . . . 33
10.5 Step 8.5: Test Checklist . . . . . . . . . . . . . . . . . . . . . . . . . . . 37
11 Documentation 38
11.1 Step 9.1: Create ADR . . . . . . . . . . . . . . . . . . . . . . . . . . . . 38
11.2 Step 9.2: Update OpenAPI Documentation . . . . . . . . . . . . . . . . . 39
12 Dependencies 41
12.1 Step 10.1: Install Required Packages . . . . . . . . . . . . . . . . . . . . 41
12.2 Step 10.2: Verify Existing Dependencies . . . . . . . . . . . . . . . . . . 41
13 Implementation Checklist 42
14 Summary of Files 43
14.1 Files to CREATE . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . 43
14.2 Files to MODIFY . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . . 43
14.3 Files to VERIFY (already exist) . . . . . . . . . . . . . . . . . . . . . . . 43
15 Production Readiness Checklist 44
16 Final Note 44
2
Idempotency Implementation Plan checkoutOs V1.0
Phase 1: Executive Summary
Step 1.1Document Purpose
This document provides a complete, detailed implementation plan for adding idempotency support to checkoutOs V1.0. The plan follows the Pure Service Layer architecture
(Option A) and complies with all handbook rules.
Step 1.2What This Plan Covers
• Complete code for all new files
• Modifications to existing files
• Redis schema and atomic operations
• Error handling and logging
• Unit and integration tests
• Documentation updates
• All production fixes identified in code review
Step 1.3Fixed Issues Summary
Issue Priority Fix Applied
Missing logging Medium Structured logs for hit/miss/in progress/stale
Race condition Low Iterative re-fetch with retry limit
Update overwrites
Medium Atomic Lua script for updates
complete() failure
Critical Try/catch with boolean return, no response
failure
orderId validation
Critical Amount/currency validation on orderId
match
IN PROGRESS
timeout
High 30-second staleness check with auto-recovery
Merchant
namespace
Low Deferred to V1.2 with code comment
Observability
metrics
Low Deferred to V1.2 per handbook Section 10
Step 1.4Success Criteria
• Same request twice returns same response
• Different payload with same key returns 400 error
• Parallel requests: one succeeds, others get 409
3
Idempotency Implementation Plan checkoutOs V1.0
• Stale IN PROGRESS records auto-recover after 30 seconds
• complete() failures never break the payment response
• orderId mismatch with different amount/currency returns error
4
Idempotency Implementation Plan checkoutOs V1.0
Phase 2: Architecture Overview
Step 2.1High-Level Flow Diagram
POST /payments
+ Idempotency-Key header
Idempotency Middleware
Responsibilities:
• Extract Idempotency-Key header
• Validate UUID v4 format
• Generate SHA256 hash of (method + path + body)
• Attach { key, hash } to req.idempotency
• NO service calls, NO Redis access
PaymentController
Responsibilities:
• Extract req.idempotency
• Call PaymentService.createPaymentWithIdempotency()
• Return JSON response
PaymentService
Responsibilities:
• Call IdempotencyService.check()
• Validate orderId (amount/currency match)
• Create payment via gateway
• Call IdempotencyService.complete()
• Never fail response if complete() fails
IdempotencyService Gateway Layer
• check() with: • Create payment via Razorpay
- Hash validation • Return paymentUrl
- Stale detection
- Race condition retry
• complete() with:
5
Idempotency Implementation Plan checkoutOs V1.0
- Atomic update
- Error recovery
IdempotencyStore
Responsibilities (ONLY layer that touches Redis):
• get(key) → record or null
• setIfNotExists(key, record) → boolean
• update(key, record) → boolean (atomic via Lua)
• Redis key: chk:idem:{key}
• TTL: 86400 seconds (24 hours)
• Atomic: SET NX for create, Lua script for update
Step 2.2Layer Responsibilities Matrix
Layer File Location Responsibilities Handbook
Ref
Types src/types/ Define interfaces, no
runtime code
Section 5.1
Errors src/errors/ Typed error classes
extending AppError
Section 5.2
Store src/store/ Redis operations
ONLY
Section 5.5
Services src/services/ Business logic orchestration
Section 5.7
Middleware src/middleware/ Header extraction,
validation ONLY
Section 4.2
Controllers src/controllers/ HTTP parsing, response sending ONLY
Section 4.2
Utils src/utils/ Pure functions, no
side effects
Section 5.3
6
Idempotency Implementation Plan checkoutOs V1.0
Phase 3: Types Layer (Foundation)
Handbook Reference: Section 5.1 - ”The foundation. Every other layer imports from
here. Written first so contracts are established before any implementation.”
Step 3.1Step 1.1: Add Idempotency Types to common.types.ts
File: src/types/common.types.ts (MODIFY existing)
1 // ============ Add to existing file ============
2 // Place after existing types but before any exports
3
4 // Idempotency Types
5 export type IdempotencyStatus = ’ IN_PROGRESS ’ | ’ COMPLETED ’;
6
7 export interface IdempotencyRecord {
8 requestHash : string ;
9 status : IdempotencyStatus ;
10 response ?: unknown ; // Optional - omitted when IN_PROGRESS per
exactOptionalPropertyTypes
11 createdAt : string ; // ISO 8601
12 updatedAt : string ; // ISO 8601
13 }
14
15 export type IdempotencyCheckResult =
16 | { type : ’ MISS ’ }
17 | { type : ’HIT ’; response : unknown }
18 | { type : ’ IN_PROGRESS ’ };
19
20 export interface IdempotencyCheckParams {
21 key : string ; // Idempotency - Key header value
22 requestHash : string ; // Hash of request ( method + path + body
)
23 }
24
25 export interface IdempotencyCompleteParams {
26 key : string ;
27 requestHash : string ;
28 response : unknown ;
29 }
30
31 // Configuration
32 export const IDEMPOTENCY_TTL_SECONDS = 86400; // 24 hours
33 export const IDEMPOTENCY_STALE_TIMEOUT_MS = 30000; // 30 seconds
34 export const IDEMPOTENCY_MAX_RETRIES = 3;
Step 3.2Step 1.2: Create Express Type Extension
File: src/types/express.types.ts (NEW)
1 import { Request } from ’ express ’;
7
Idempotency Implementation Plan checkoutOs V1.0
2
3 declare global {
4 namespace Express {
5 interface Request {
6 idempotency ?: {
7 key : string ;
8 requestHash : string ;
9 };
10 }
11 }
12 }
13
14 // Empty export to make this a module
15 export {};
Step 3.3Step 1.3: Create Idempotency Error Types
File: src/errors/idempotency.errors.ts (NEW)
1 import { AppError } from ’./ app . errors ’;
2
3 export class IdempotencyKeyReusedError extends AppError {
4 readonly httpStatus = 400;
5 readonly code = ’ IDEMPOTENCY_KEY_REUSED ’;
6 readonly isOperational = true ;
7
8 constructor ( key : string ) {
9 super ( ‘ Idempotency key "${ key }" reused with different request
payload ‘) ;
10 this . details = { key };
11 }
12 }
13
14 export class IdempotencyInProgressError extends AppError {
15 readonly httpStatus = 409;
16 readonly code = ’ REQUEST_IN_PROGRESS ’;
17 readonly isOperational = true ;
18
19 constructor ( key : string ) {
20 super ( ‘ Request with idempotency key "${ key }" is already in
progress ‘) ;
21 this . details = { key };
22 }
23 }
24
25 export class IdempotencyKeyMissingError extends AppError {
26 readonly httpStatus = 400;
27 readonly code = ’ MISSING_IDEMPOTENCY_KEY ’;
28 readonly isOperational = true ;
29
30 constructor () {
8
Idempotency Implementation Plan checkoutOs V1.0
31 super ( ’ Idempotency - Key header is required for this endpoint ’)
;
32 this . details = {};
33 }
34 }
35
36 export class IdempotencyKeyInvalidError extends AppError {
37 readonly httpStatus = 400;
38 readonly code = ’ INVALID_IDEMPOTENCY_KEY ’;
39 readonly isOperational = true ;
40
41 constructor ( key : string ) {
42 super ( ‘ Idempotency key "${ key }" is invalid . Must be UUID v4
format . ‘) ;
43 this . details = { key };
44 }
45 }
Step 3.4Step 1.4: Create OrderId Mismatch Errors
File: src/errors/payment.errors.ts (MODIFY existing)
1 // Add to existing file
2
3 export class OrderIdAmountMismatchError extends AppError {
4 readonly httpStatus = 409;
5 readonly code = ’ ORDER_ID_AMOUNT_MISMATCH ’;
6 readonly isOperational = true ;
7
8 constructor ( orderId : string , existingAmount : number , newAmount :
number ) {
9 super ( ‘ OrderId "${ orderId }" already exists with amount ${
existingAmount } , cannot create with different amount ${
newAmount } ‘) ;
10 this . details = { orderId , existingAmount , newAmount };
11 }
12 }
13
14 export class OrderIdCurrencyMismatchError extends AppError {
15 readonly httpStatus = 409;
16 readonly code = ’ ORDER_ID_CURRENCY_MISMATCH ’;
17 readonly isOperational = true ;
18
19 constructor ( orderId : string , existingCurrency : string ,
newCurrency : string ) {
20 super ( ‘ OrderId "${ orderId }" already exists with currency ${
existingCurrency } , cannot create with different currency $
{ newCurrency } ‘) ;
21 this . details = { orderId , existingCurrency , newCurrency };
22 }
23 }
9
Idempotency Implementation Plan checkoutOs V1.0
Step 3.5Step 1.5: Import Pattern Verification
No barrel files. Import directly:
1 // Correct import pattern
2 import { IdempotencyKeyReusedError } from ’../ errors / idempotency .
errors ’;
3 import { IdempotencyRecord } from ’../ types / common . types ’;
4 import * as idempotencyStore from ’../ store / idempotency . store ’;
10
Idempotency Implementation Plan checkoutOs V1.0
Phase 4: Store Layer
Handbook Reference: Section 5.5 - ”The only layer that interacts with Redis. Services,
controllers, gateways, and middleware never access Redis directly.”
Step 4.1Step 2.1: Create Idempotency Store
File: src/store/idempotency.store.ts (NEW)
1 import { redis } from ’./ redis . client ’;
2 import { IdempotencyRecord , IDEMPOTENCY_TTL_SECONDS } from ’../
types / common . types ’;
3
4 const KEY_PREFIX = ’ chk : idem : ’;
5
6 // Lua script for atomic update - FIX Issue 4
7 const atomicUpdateScript = ‘
8 local key = KEYS [1]
9 local newRecord = ARGV [1]
10 local ttl = ARGV [2]
11
12 local existing = redis . call ( ’ GET ’ , key )
13 if not existing then
14 return 0
15 end
16
17 redis . call ( ’ SET ’ , key , newRecord , ’EX ’ , ttl )
18 return 1
19 ‘;
20
21 /**
22 * Generate Redis key from idempotency key
23 *
24 * NOTE Issue 8: Merchant namespace deferred to V1 .2
25 * Current : chk : idem :{ key }
26 * V1 .2: chk : idem :{ merchantId }:{ key }
27 */
28 function getKey ( idempotencyKey : string ) : string {
29 return ‘${ KEY_PREFIX }${ idempotencyKey } ‘;
30 }
31
32 /**
33 * Get idempotency record by key
34 * Returns null if not found or corrupted
35 */
36 export async function getIdempotencyRecord (
37 key : string
38 ) : Promise < IdempotencyRecord | null > {
39 const data = await redis . get ( getKey ( key ) ) ;
40
41 if (! data ) {
11
Idempotency Implementation Plan checkoutOs V1.0
42 return null ;
43 }
44
45 try {
46 return JSON . parse ( data ) as IdempotencyRecord ;
47 } catch {
48 // Corrupted data - treat as not found
49 return null ;
50 }
51 }
52
53 /**
54 * Atomically set idempotency record if key does not exist
55 * Returns true if set , false if key already exists
56 * Uses SET NX for atomic operation
57 */
58 export async function setIdempotencyRecordIfNotExists (
59 key : string ,
60 record : IdempotencyRecord
61 ) : Promise < boolean > {
62 const result = await redis . set (
63 getKey ( key ) ,
64 JSON . stringify ( record ) ,
65 ’NX ’ ,
66 ’EX ’ ,
67 IDEMPOTENCY_TTL_SECONDS
68 ) ;
69
70 return result === ’OK ’;
71 }
72
73 /**
74 * Update existing idempotency record atomically
75 * Returns true if updated , false if record didn ’ t exist
76 * Uses Lua script for atomicity - FIX Issue 4
77 */
78 export async function updateIdempotencyRecord (
79 key : string ,
80 record : IdempotencyRecord
81 ) : Promise < boolean > {
82 const result = await redis . eval (
83 atomicUpdateScript ,
84 1 ,
85 getKey ( key ) ,
86 JSON . stringify ( record ) ,
87 IDEMPOTENCY_TTL_SECONDS
88 ) ;
89
90 return result === 1;
91 }
92
12
Idempotency Implementation Plan checkoutOs V1.0
93 /**
94 * Delete idempotency record ( for testing only )
95 */
96 export async function deleteIdempotencyRecord ( key : string ) :
Promise < void > {
97 await redis . del ( getKey ( key ) ) ;
98 }
Step 4.2Step 2.2: Verify Redis Client Exists
File: src/store/redis.client.ts (EXISTS - verify)
1 // Verify this file exists per Section 3.4
2 // Should export :
3 // export const redis = new Redis ( REDIS_URL ) ;
13
Idempotency Implementation Plan checkoutOs V1.0
Phase 5: Service Layer
Handbook Reference: Section 5.7 - ”Services own all business logic and orchestrate
between the gateway, store, config, and utils layers.”
Step 5.1Step 3.1: Create Idempotency Service
File: src/services/idempotency.service.ts (NEW)
1 // Direct imports - NO barrel files
2 import * as idempotencyStore from ’../ store / idempotency . store ’;
3 import {
4 IdempotencyCheckParams ,
5 IdempotencyCompleteParams ,
6 IdempotencyCheckResult ,
7 IdempotencyRecord ,
8 IDEMPOTENCY_STALE_TIMEOUT_MS ,
9 IDEMPOTENCY_MAX_RETRIES
10 } from ’../ types / common . types ’;
11 import {
12 IdempotencyKeyReusedError
13 } from ’../ errors / idempotency . errors ’;
14 import { now } from ’../ utils / time ’;
15 import { logger } from ’../ utils / logger ’;
16
17 /**
18 * Check if an IN_PROGRESS record is stale
19 * FIX Issue 7: Stale detection
20 */
21 function isStale ( updatedAt : string ) : boolean {
22 const updated = new Date ( updatedAt ) . getTime () ;
23 const current = new Date () . getTime () ;
24 return ( current - updated ) > IDEMPOTENCY_STALE_TIMEOUT_MS ;
25 }
26
27 /**
28 * Idempotency Service - Handles all idempotency business logic
29 * This service is called by PaymentService , NOT by middleware
30 */
31 export class IdempotencyService {
32
33 /**
34 * Check idempotency status for incoming request
35 *
36 * Returns :
37 * - MISS : No existing request , proceed ( record created as
IN_PROGRESS )
38 * - HIT : Completed request exists , return cached response
39 * - IN_PROGRESS : Another request with same key is processing
40 *
41 * Throws : IdempotencyKeyReusedError if same key with different
14
Idempotency Implementation Plan checkoutOs V1.0
hash
42 *
43 * FIX Issue 3: Iterative re - fetch instead of recursion
44 * FIX Issue 7: Stale IN_PROGRESS detection and recovery
45 * FIX Issue 2: Structured logging
46 */
47 async check ( params : IdempotencyCheckParams ) : Promise <
IdempotencyCheckResult > {
48 const { key , requestHash } = params ;
49 let retries = IDEMPOTENCY_MAX_RETRIES ;
50
51 while ( retries > 0) {
52 const existing = await idempotencyStore .
getIdempotencyRecord ( key ) ;
53
54 // Case 1: No existing record - create one
55 if (! existing ) {
56 const record : IdempotencyRecord = {
57 requestHash ,
58 status : ’ IN_PROGRESS ’ ,
59 createdAt : now () ,
60 updatedAt : now ()
61 };
62
63 const created = await idempotencyStore .
setIdempotencyRecordIfNotExists ( key , record ) ;
64
65 if ( created ) {
66 logger . info ( ’ idempotency . miss ’ , { key , requestHash }) ;
67 return { type : ’ MISS ’ };
68 }
69
70 // Race condition - another request won , retry
71 retries - -;
72 logger . debug ( ’ idempotency . race_retry ’ , { key , retriesLeft
: retries }) ;
73 continue ;
74 }
75
76 // Case 2: Existing record - validate hash
77 if ( existing . requestHash !== requestHash ) {
78 logger . warn ( ’ idempotency . hash_mismatch ’ , { key ,
existingHash : existing . requestHash , newHash :
requestHash }) ;
79 throw new IdempotencyKeyReusedError ( key ) ;
80 }
81
82 // Case 3: Check for stale IN_PROGRESS ( FIX Issue 7)
83 if ( existing . status === ’ IN_PROGRESS ’ && isStale ( existing .
updatedAt ) ) {
84 logger . warn ( ’ idempotency . stale_in_progress ’ , {
15
Idempotency Implementation Plan checkoutOs V1.0
85 key ,
86 updatedAt : existing . updatedAt ,
87 stalenessMs : new Date () . getTime () - new Date ( existing .
updatedAt ) . getTime ()
88 }) ;
89
90 // Overwrite stale record
91 const newRecord : IdempotencyRecord = {
92 requestHash ,
93 status : ’ IN_PROGRESS ’ ,
94 createdAt : now () ,
95 updatedAt : now ()
96 };
97
98 await idempotencyStore . setIdempotencyRecordIfNotExists (
key , newRecord ) ;
99 logger . info ( ’ idempotency . stale_overwritten ’ , { key }) ;
100 return { type : ’ MISS ’ };
101 }
102
103 // Case 4: Completed request
104 if ( existing . status === ’ COMPLETED ’) {
105 logger . debug ( ’ idempotency . hit ’ , { key }) ;
106 return {
107 type : ’HIT ’ ,
108 response : existing . response as unknown
109 };
110 }
111
112 // Case 5: Fresh IN_PROGRESS
113 logger . debug ( ’ idempotency . in_progress ’ , { key , updatedAt :
existing . updatedAt }) ;
114 return { type : ’ IN_PROGRESS ’ };
115 }
116
117 // Exhausted retries - treat as IN_PROGRESS
118 logger . error ( ’ idempotency . race_condition_retry_exhausted ’ , {
key }) ;
119 return { type : ’ IN_PROGRESS ’ };
120 }
121
122 /**
123 * Mark idempotency request as COMPLETED with response
124 * Called after successful payment creation
125 *
126 * FIX Issue 5: Error handling - never throws , returns boolean
127 * FIX Issue 4: Uses atomic update
128 */
129 async complete ( params : IdempotencyCompleteParams ) : Promise <
boolean > {
130 const { key , requestHash , response } = params ;
16
Idempotency Implementation Plan checkoutOs V1.0
131
132 try {
133 const existing = await idempotencyStore .
getIdempotencyRecord ( key ) ;
134
135 if (! existing ) {
136 // This shouldn ’ t happen if check () was called first
137 // But handle gracefully - create record as COMPLETED
138 const record : IdempotencyRecord = {
139 requestHash ,
140 status : ’ COMPLETED ’ ,
141 response ,
142 createdAt : now () ,
143 updatedAt : now ()
144 };
145 const success = await idempotencyStore .
setIdempotencyRecordIfNotExists ( key , record ) ;
146 if ( success ) {
147 logger . info ( ’ idempotency . completed_created ’ , { key }) ;
148 } else {
149 logger . warn ( ’ idempotency . completed_create_failed ’ , {
key }) ;
150 }
151 return success ;
152 }
153
154 // Validate hash matches
155 if ( existing . requestHash !== requestHash ) {
156 logger . error ( ’ idempotency . complete_hash_mismatch ’ , { key
}) ;
157 // Don ’ t throw - just log and return false
158 return false ;
159 }
160
161 // Update to COMPLETED
162 const updatedRecord : IdempotencyRecord = {
163 ... existing ,
164 status : ’ COMPLETED ’ ,
165 response ,
166 updatedAt : now ()
167 };
168
169 const success = await idempotencyStore .
updateIdempotencyRecord ( key , updatedRecord ) ;
170
171 if ( success ) {
172 logger . info ( ’ idempotency . completed ’ , { key }) ;
173 } else {
174 logger . error ( ’ idempotency . complete_update_failed ’ , { key
}) ;
175 }
17
Idempotency Implementation Plan checkoutOs V1.0
176
177 return success ;
178
179 } catch ( error ) {
180 // FIX Issue 5: Never throw from complete () - log and
return false
181 logger . error ( ’ idempotency . complete_critical_failure ’ , {
182 key ,
183 error : error instanceof Error ? error . message : String (
error )
184 }) ;
185
186 // TODO V1 .2: Send to dead letter queue for reconciliation
187 // await deadLetterQueue . send ( ’ idempotency . complete . failed
’ , {
188 // key ,
189 // paymentId : response ?. paymentId
190 // }) ;
191
192 return false ;
193 }
194 }
195 }
196
197 // Singleton instance
198 export const idempotencyService = new IdempotencyService () ;
Step 5.2Step 3.2: Modify Payment Service
File: src/services/payment.service.ts (MODIFY existing)
1 // Add these imports to existing file
2 import { idempotencyService } from ’./ idempotency . service ’;
3 import {
4 IdempotencyInProgressError ,
5 OrderIdAmountMismatchError ,
6 OrderIdCurrencyMismatchError
7 } from ’../ errors / idempotency . errors ’;
8 import { paymentStore } from ’../ store / payment . store ’;
9 import { StoredPayment , PaymentResponse } from ’../ types / payment .
types ’;
10 import { logger } from ’../ utils / logger ’;
11
12 // Add this method to existing PaymentService class
13 export class PaymentService {
14
15 // ... existing methods ...
16
17 /**
18 * Create payment with idempotency support
19 * This is the main entry point for POST / payments
18
Idempotency Implementation Plan checkoutOs V1.0
20 *
21 * FIX Issue 6: OrderId validation with amount / currency check
22 * FIX Issue 5: complete () failure never breaks response
23 */
24 async createPaymentWithIdempotency ( params : {
25 amount : number ;
26 currency : string ;
27 orderId : string ;
28 description ?: string ;
29 idempotencyKey ?: string ;
30 idempotencyHash ?: string ;
31 }) : Promise < PaymentResponse > {
32
33 // Step 1: Idempotency check ( if key provided )
34 if ( params . idempotencyKey && params . idempotencyHash ) {
35 const checkResult = await idempotencyService . check ({
36 key : params . idempotencyKey ,
37 requestHash : params . idempotencyHash
38 }) ;
39
40 if ( checkResult . type === ’HIT ’) {
41 return checkResult . response as PaymentResponse ;
42 }
43
44 if ( checkResult . type === ’ IN_PROGRESS ’) {
45 throw new IdempotencyInProgressError ( params .
idempotencyKey ) ;
46 }
47
48 // type === ’ MISS ’ - proceed to create payment
49 }
50
51 // Step 2: OrderId dedup with strict validation ( FIX Issue 6)
52 const existingPayment = await paymentStore . findByOrderId (
params . orderId ) ;
53 if ( existingPayment ) {
54 // Validate amount matches
55 const existingAmount = parseInt ( existingPayment . amount ) ;
56 if ( existingAmount !== params . amount ) {
57 logger . error ( ’ orderId . amount_mismatch ’ , {
58 orderId : params . orderId ,
59 existingAmount ,
60 newAmount : params . amount
61 }) ;
62 throw new OrderIdAmountMismatchError ( params . orderId ,
existingAmount , params . amount ) ;
63 }
64
65 // Validate currency matches
66 if ( existingPayment . currency !== params . currency ) {
67 logger . error ( ’ orderId . currency_mismatch ’ , {
19
Idempotency Implementation Plan checkoutOs V1.0
68 orderId : params . orderId ,
69 existingCurrency : existingPayment . currency ,
70 newCurrency : params . currency
71 }) ;
72 throw new OrderIdCurrencyMismatchError ( params . orderId ,
existingPayment . currency , params . currency ) ;
73 }
74
75 logger . debug ( ’ orderId . dedup_hit ’ , {
76 orderId : params . orderId ,
77 paymentId : existingPayment . chkId
78 }) ;
79
80 return this . mapStoredToResponse ( existingPayment ) ;
81 }
82
83 // Step 3: Create payment ( existing logic )
84 const payment = await this . createPayment ({
85 amount : params . amount ,
86 currency : params . currency ,
87 orderId : params . orderId ,
88 description : params . description
89 }) ;
90
91 // Step 4: Mark idempotency as COMPLETED ( if key provided )
92 // FIX Issue 5: Don ’ t fail response if complete () fails
93 if ( params . idempotencyKey && params . idempotencyHash ) {
94 const completed = await idempotencyService . complete ({
95 key : params . idempotencyKey ,
96 requestHash : params . idempotencyHash ,
97 response : payment
98 }) ;
99
100 if (! completed ) {
101 // Logged inside complete () - don ’ t fail the response
102 logger . warn ( ’ idempotency . complete_non_critical_failure ’ ,
{
103 key : params . idempotencyKey ,
104 paymentId : payment . paymentId
105 }) ;
106 }
107 }
108
109 return payment ;
110 }
111
112 /**
113 * Map stored payment to API response
114 * Private method - no external caller needs this
115 */
116 private mapStoredToResponse ( stored : StoredPayment ) :
20
Idempotency Implementation Plan checkoutOs V1.0
PaymentResponse {
117 return {
118 paymentId : stored . chkId ,
119 paymentUrl : ’’, // Would need to be stored or regenerated
120 status : stored . status ,
121 amount : parseInt ( stored . amount ) ,
122 currency : stored . currency ,
123 gateway : stored . gateway ,
124 orderId : stored . orderId ,
125 createdAt : stored . createdAt
126 };
127 }
128
129 // Keep existing createPayment method for internal use
130 private async createPayment ( params : {
131 amount : number ;
132 currency : string ;
133 orderId : string ;
134 description ?: string ;
135 }) : Promise < PaymentResponse > {
136 // ... existing implementation ...
137 }
138 }
21
Idempotency Implementation Plan checkoutOs V1.0
Phase 6: Middleware Layer
Handbook Reference: Section 4.2 - Middleware handles ”Cross-cutting concerns: logging, errors, body parsing”
CRITICAL: Middleware does NOT call services or access Redis per Section 5.5.
Step 6.1Step 4.1: Create Idempotency Middleware
File: src/middleware/idempotency.middleware.ts (NEW)
1 import { Request , Response , NextFunction } from ’ express ’;
2 import { validate as isUUID } from ’ uuid ’;
3 import { createHash } from ’ crypto ’;
4 import {
5 IdempotencyKeyMissingError ,
6 IdempotencyKeyInvalidError
7 } from ’../ errors / idempotency . errors ’;
8
9 /**
10 * Generate hash from request method , path , and body
11 * Pure function - no side effects
12 */
13 function generateRequestHash ( method : string , path : string , body :
unknown ) : string {
14 const normalizedBody = body ? JSON . stringify ( body ) : ’ ’;
15 const data = ‘${ method }:${ path }:${ normalizedBody } ‘;
16 return createHash ( ’ sha256 ’) . update ( data ) . digest ( ’ hex ’) ;
17 }
18
19 /**
20 * Idempotency Middleware
21 *
22 * RESPONSIBILITIES ( ONLY ) :
23 * 1. Extract Idempotency - Key header
24 * 2. Validate UUID format
25 * 3. Generate request hash
26 * 4. Attach to req . idempotency
27 *
28 * DOES NOT ( per handbook ) :
29 * - Call any service ( Section 5.7)
30 * - Access Redis ( Section 5.5)
31 * - Make decisions about HIT / MISS / IN_PROGRESS
32 * - Return 409 ( that ’ s service layer ’ s job )
33 */
34 export async function idempotencyMiddleware (
35 req : Request ,
36 res : Response ,
37 next : NextFunction
38 ) : Promise < void > {
39 try {
22
Idempotency Implementation Plan checkoutOs V1.0
40 const key = req . headers [ ’ idempotency - key ’] as string |
undefined ;
41
42 // Idempotency key is REQUIRED for POST / payments
43 if (! key ) {
44 throw new IdempotencyKeyMissingError () ;
45 }
46
47 // Validate UUID v4 format
48 if (! isUUID ( key ) ) {
49 throw new IdempotencyKeyInvalidError ( key ) ;
50 }
51
52 // Generate hash for downstream use
53 const requestHash = generateRequestHash (
54 req . method ,
55 req . path ,
56 req . body
57 ) ;
58
59 // Attach to request for controller / service
60 req . idempotency = {
61 key ,
62 requestHash
63 };
64
65 next () ;
66 } catch ( error ) {
67 next ( error ) ; // Pass to error handler middleware
68 }
69 }
23
Idempotency Implementation Plan checkoutOs V1.0
Phase 7: Controller Layer
Handbook Reference: Section 4.2 - Controllers handle ”HTTP request parsing and
response sending ONLY”
Step 7.1Step 5.1: Modify Payment Controller
File: src/controllers/payment.controller.ts (MODIFY)
1 import { Request , Response } from ’ express ’;
2 import { paymentService } from ’../ services / payment . service ’;
3 import { CreatePaymentRequest } from ’../ types / payment . types ’;
4
5 // Import express types to enable req . idempotency
6 import ’../ types / express . types ’;
7
8 export class PaymentController {
9
10 /**
11 * POST / payments
12 * Create a new payment with idempotency support
13 * Explicit return type per handbook Section 2.1
14 */
15 async createPayment ( req : Request , res : Response ) : Promise < void >
{
16 const body = req . body as CreatePaymentRequest ;
17
18 // Extract idempotency data from middleware
19 // Middleware already validated and attached
20 const { idempotency } = req ;
21
22 // Call service with idempotency params
23 // Service handles all business logic including idempotency
24 const result = await paymentService .
createPaymentWithIdempotency ({
25 amount : body . amount ,
26 currency : body . currency ,
27 orderId : body . orderId ,
28 description : body . description ,
29 idempotencyKey : idempotency ?. key ,
30 idempotencyHash : idempotency ?. requestHash
31 }) ;
32
33 // Send response - controller ’ s only job
34 res . json ({
35 success : true ,
36 data : result
37 }) ;
38 }
39
40 // ... existing methods ( getPayment , createRefund , etc .) remain
24
Idempotency Implementation Plan checkoutOs V1.0
unchanged
41 }
25
Idempotency Implementation Plan checkoutOs V1.0
Phase 8: Routes/Middleware Registration
Step 8.1Step 6.1: Register Middleware on Route
File: src/app.ts or src/routes/payment.routes.ts (MODIFY)
1 import express from ’ express ’;
2 import { idempotencyMiddleware } from ’./ middleware / idempotency .
middleware ’;
3 import { paymentController } from ’./ controllers / payment .
controller ’;
4
5 const app = express () ;
6
7 // Apply idempotency middleware to POST / payments ONLY
8 // Other endpoints don ’ t require idempotency per design doc
9 app . post ( ’/ payments ’ ,
10 idempotencyMiddleware ,
11 paymentController . createPayment
12 ) ;
13
14 // Other routes remain unchanged
15 // GET / payments /: chkId - no idempotency needed
16 // POST / payments /: chkId / refund - idempotency optional ( deferred
to V1 .2)
26
Idempotency Implementation Plan checkoutOs V1.0
Phase 9: Utility Functions
Handbook Reference: Section 5.3 - ”Pure functions. Zero dependencies on any other
layer. No side effects.”
Step 9.1Step 7.1: Verify Time Utility Exists
File: src/utils/time.ts (EXISTS - verify per Section 3.4)
1 // Should already exist . If not , create :
2 export function now () : string {
3 return new Date () . toISOString () ;
4 }
5
6 export function toISOString ( date : Date ) : string {
7 return date . toISOString () ;
8 }
9
10 export function isValidISOString ( str : string ) : boolean {
11 return ! isNaN ( Date . parse ( str ) ) ;
12 }
Step 9.2Step 7.2: Create Hash Utility (Optional)
File: src/utils/hash.ts (NEW - optional)
1 import { createHash } from ’ crypto ’;
2
3 /**
4 * Pure function - no side effects
5 * Creates deterministic hash from request components
6 */
7 export function createRequestHash ( method : string , path : string ,
body : unknown ) : string {
8 const normalizedBody = body ? JSON . stringify ( body ) : ’ ’;
9 const data = ‘${ method }:${ path }:${ normalizedBody } ‘;
10 return createHash ( ’ sha256 ’) . update ( data ) . digest ( ’ hex ’) ;
11 }
27
Idempotency Implementation Plan checkoutOs V1.0
Phase 10: Testing
Handbook Reference: Section 8 - ”Tests protect business invariants, not implementation details.”
Step 10.1Step 8.1: Store Layer Unit Tests
File: tests/unit/store/idempotency.store.test.ts (NEW)
1 import { describe , it , expect , beforeEach , afterEach } from ’
@jest / globals ’;
2 import * as idempotencyStore from ’../../../ src / store / idempotency
. store ’;
3 import { redis } from ’../../../ src / store / redis . client ’;
4
5 describe ( ’ IdempotencyStore ’ , () = > {
6 beforeEach ( async () = > {
7 await redis . flushall () ;
8 }) ;
9
10 afterEach ( async () = > {
11 await redis . flushall () ;
12 }) ;
13
14 it ( ’ should set and get record ’ , async () = > {
15 const key = ’ test - key -1 ’;
16 const record = {
17 requestHash : ’ hash123 ’ ,
18 status : ’ IN_PROGRESS ’ as const ,
19 createdAt : new Date () . toISOString () ,
20 updatedAt : new Date () . toISOString ()
21 };
22
23 const setResult = await idempotencyStore .
setIdempotencyRecordIfNotExists ( key , record ) ;
24 expect ( setResult ) . toBe ( true ) ;
25
26 const retrieved = await idempotencyStore . getIdempotencyRecord
( key ) ;
27 expect ( retrieved ) . toEqual ( record ) ;
28 }) ;
29
30 it ( ’ should not set if key already exists ’ , async () = > {
31 const key = ’ test - key -2 ’;
32 const record1 = {
33 requestHash : ’ hash1 ’ ,
34 status : ’ IN_PROGRESS ’ as const ,
35 createdAt : ’2024 -01 -01 T00 :00:00.000 Z ’ ,
36 updatedAt : ’2024 -01 -01 T00 :00:00.000 Z ’
37 };
38 const record2 = {
28
Idempotency Implementation Plan checkoutOs V1.0
39 requestHash : ’ hash2 ’ ,
40 status : ’ IN_PROGRESS ’ as const ,
41 createdAt : ’2024 -01 -01 T00 :00:00.000 Z ’ ,
42 updatedAt : ’2024 -01 -01 T00 :00:00.000 Z ’
43 };
44
45 await idempotencyStore . setIdempotencyRecordIfNotExists ( key ,
record1 ) ;
46 const setResult = await idempotencyStore .
setIdempotencyRecordIfNotExists ( key , record2 ) ;
47
48 expect ( setResult ) . toBe ( false ) ;
49 }) ;
50
51 it ( ’ should update existing record atomically ’ , async () = > {
52 const key = ’ test - key -3 ’;
53 const record = {
54 requestHash : ’ hash123 ’ ,
55 status : ’ IN_PROGRESS ’ as const ,
56 createdAt : ’2024 -01 -01 T00 :00:00.000 Z ’ ,
57 updatedAt : ’2024 -01 -01 T00 :00:00.000 Z ’
58 };
59
60 await idempotencyStore . setIdempotencyRecordIfNotExists ( key ,
record ) ;
61
62 const updated = {
63 ... record ,
64 status : ’ COMPLETED ’ as const ,
65 response : { paymentId : ’ chk_123 ’ } ,
66 updatedAt : ’2024 -01 -01 T00 :01:00.000 Z ’
67 };
68
69 const updateResult = await idempotencyStore .
updateIdempotencyRecord ( key , updated ) ;
70 expect ( updateResult ) . toBe ( true ) ;
71
72 const retrieved = await idempotencyStore . getIdempotencyRecord
( key ) ;
73 expect ( retrieved ?. status ) . toBe ( ’ COMPLETED ’) ;
74 expect ( retrieved ?. response ) . toEqual ({ paymentId : ’ chk_123 ’ })
;
75 }) ;
76
77 it ( ’ should return false when updating non - existent key ’ , async
() = > {
78 const key = ’non - existent ’;
79 const record = {
80 requestHash : ’ hash123 ’ ,
81 status : ’ COMPLETED ’ as const ,
82 response : { paymentId : ’ chk_123 ’ } ,
29
Idempotency Implementation Plan checkoutOs V1.0
83 createdAt : ’2024 -01 -01 T00 :00:00.000 Z ’ ,
84 updatedAt : ’2024 -01 -01 T00 :00:00.000 Z ’
85 };
86
87 const updateResult = await idempotencyStore .
updateIdempotencyRecord ( key , record ) ;
88 expect ( updateResult ) . toBe ( false ) ;
89 }) ;
90
91 it ( ’ should return null for non - existent key ’ , async () = > {
92 const retrieved = await idempotencyStore . getIdempotencyRecord
( ’ non - existent ’) ;
93 expect ( retrieved ) . toBe ( null ) ;
94 }) ;
95 }) ;
Step 10.2Step 8.2: Service Layer Unit Tests
File: tests/unit/services/idempotency.service.test.ts (NEW)
1 import { describe , it , expect , beforeEach , jest } from ’ @jest /
globals ’;
2 import { IdempotencyService } from ’../../../ src / services /
idempotency . service ’;
3 import * as idempotencyStore from ’../../../ src / store / idempotency
. store ’;
4 import { IdempotencyKeyReusedError } from ’../../../ src / errors /
idempotency . errors ’;
5
6 describe ( ’ IdempotencyService ’ , () = > {
7 let service : IdempotencyService ;
8
9 beforeEach (() = > {
10 service = new IdempotencyService () ;
11 jest . clearAllMocks () ;
12 }) ;
13
14 it ( ’ should return MISS and create record for new key ’ , async ()
= > {
15 jest . spyOn ( idempotencyStore , ’ getIdempotencyRecord ’) .
mockResolvedValue ( null ) ;
16 jest . spyOn ( idempotencyStore , ’ setIdempotencyRecordIfNotExists
’) . mockResolvedValue ( true ) ;
17
18 const result = await service . check ({
19 key : ’123 e4567 - e89b -12 d3 - a456 -426614174000 ’ ,
20 requestHash : ’ hash123 ’
21 }) ;
22
23 expect ( result ) . toEqual ({ type : ’ MISS ’ }) ;
30
Idempotency Implementation Plan checkoutOs V1.0
24 expect ( idempotencyStore . setIdempotencyRecordIfNotExists ) .
toHaveBeenCalled () ;
25 }) ;
26
27 it ( ’ should return HIT with response for completed request ’ ,
async () = > {
28 const response = { paymentId : ’ chk_123 ’ };
29 jest . spyOn ( idempotencyStore , ’ getIdempotencyRecord ’) .
mockResolvedValue ({
30 requestHash : ’ hash123 ’ ,
31 status : ’ COMPLETED ’ ,
32 response ,
33 createdAt : ’2024 -01 -01 T00 :00:00.000 Z ’ ,
34 updatedAt : ’2024 -01 -01 T00 :00:00.000 Z ’
35 }) ;
36
37 const result = await service . check ({
38 key : ’123 e4567 - e89b -12 d3 - a456 -426614174000 ’ ,
39 requestHash : ’ hash123 ’
40 }) ;
41
42 expect ( result ) . toEqual ({ type : ’HIT ’ , response }) ;
43 }) ;
44
45 it ( ’ should return IN_PROGRESS for pending request ’ , async () = >
{
46 jest . spyOn ( idempotencyStore , ’ getIdempotencyRecord ’) .
mockResolvedValue ({
47 requestHash : ’ hash123 ’ ,
48 status : ’ IN_PROGRESS ’ ,
49 createdAt : ’2024 -01 -01 T00 :00:00.000 Z ’ ,
50 updatedAt : ’2024 -01 -01 T00 :00:00.000 Z ’
51 }) ;
52
53 const result = await service . check ({
54 key : ’123 e4567 - e89b -12 d3 - a456 -426614174000 ’ ,
55 requestHash : ’ hash123 ’
56 }) ;
57
58 expect ( result ) . toEqual ({ type : ’ IN_PROGRESS ’ }) ;
59 }) ;
60
61 it ( ’ should throw IdempotencyKeyReusedError for hash mismatch ’ ,
async () = > {
62 jest . spyOn ( idempotencyStore , ’ getIdempotencyRecord ’) .
mockResolvedValue ({
63 requestHash : ’ different - hash ’ ,
64 status : ’ IN_PROGRESS ’ ,
65 createdAt : ’2024 -01 -01 T00 :00:00.000 Z ’ ,
66 updatedAt : ’2024 -01 -01 T00 :00:00.000 Z ’
67 }) ;
31
Idempotency Implementation Plan checkoutOs V1.0
68
69 await expect ( service . check ({
70 key : ’123 e4567 - e89b -12 d3 - a456 -426614174000 ’ ,
71 requestHash : ’ hash123 ’
72 }) ) . rejects . toThrow ( IdempotencyKeyReusedError ) ;
73 }) ;
74 }) ;
Step 10.3Step 8.3: Stale IN PROGRESS Tests
File: tests/unit/services/idempotency.service.stale.test.ts (NEW)
1 import { describe , it , expect , beforeEach , jest , afterEach } from
’ @jest / globals ’;
2 import { IdempotencyService } from ’../../../ src / services /
idempotency . service ’;
3 import * as idempotencyStore from ’../../../ src / store / idempotency
. store ’;
4
5 describe ( ’ IdempotencyService - Stale IN_PROGRESS ( Issue 7) ’, ()
= > {
6 let service : IdempotencyService ;
7
8 beforeEach (() = > {
9 service = new IdempotencyService () ;
10 jest . clearAllMocks () ;
11 jest . useFakeTimers () ;
12 }) ;
13
14 afterEach (() = > {
15 jest . useRealTimers () ;
16 }) ;
17
18 it ( ’ should treat stale IN_PROGRESS as MISS and overwrite ’ ,
async () = > {
19 const staleDate = new Date () ;
20 staleDate . setSeconds ( staleDate . getSeconds () - 31) ; // 31
seconds ago ( > 30 s threshold )
21
22 jest . spyOn ( idempotencyStore , ’ getIdempotencyRecord ’) .
mockResolvedValue ({
23 requestHash : ’old - hash ’ ,
24 status : ’ IN_PROGRESS ’ ,
25 createdAt : staleDate . toISOString () ,
26 updatedAt : staleDate . toISOString ()
27 }) ;
28
29 jest . spyOn ( idempotencyStore , ’ setIdempotencyRecordIfNotExists
’) . mockResolvedValue ( true ) ;
30
31 const result = await service . check ({
32
Idempotency Implementation Plan checkoutOs V1.0
32 key : ’ test - key ’ ,
33 requestHash : ’new - hash ’
34 }) ;
35
36 expect ( result ) . toEqual ({ type : ’ MISS ’ }) ;
37 expect ( idempotencyStore . setIdempotencyRecordIfNotExists ) .
toHaveBeenCalled () ;
38 }) ;
39
40 it ( ’ should treat fresh IN_PROGRESS as IN_PROGRESS ’ , async () = >
{
41 const freshDate = new Date () ;
42 freshDate . setSeconds ( freshDate . getSeconds () - 5) ; // 5
seconds ago ( < 30 s threshold )
43
44 jest . spyOn ( idempotencyStore , ’ getIdempotencyRecord ’) .
mockResolvedValue ({
45 requestHash : ’ same - hash ’ ,
46 status : ’ IN_PROGRESS ’ ,
47 createdAt : freshDate . toISOString () ,
48 updatedAt : freshDate . toISOString ()
49 }) ;
50
51 const result = await service . check ({
52 key : ’ test - key ’ ,
53 requestHash : ’ same - hash ’
54 }) ;
55
56 expect ( result ) . toEqual ({ type : ’ IN_PROGRESS ’ }) ;
57 expect ( idempotencyStore . setIdempotencyRecordIfNotExists ) . not .
toHaveBeenCalled () ;
58 }) ;
59 }) ;
Step 10.4Step 8.4: Integration Tests
File: tests/integration/idempotency.test.ts (NEW)
1 import { describe , it , expect , beforeAll , afterAll } from ’ @jest /
globals ’;
2 import request from ’ supertest ’;
3 import { app } from ’../../../ src / app ’;
4 import { redis } from ’../../../ src / store / redis . client ’;
5
6 describe ( ’ Idempotency Integration - Section 12 Test Checklist ’ ,
() = > {
7 beforeAll ( async () = > {
8 await redis . flushall () ;
9 }) ;
10
11 afterAll ( async () = > {
33
Idempotency Implementation Plan checkoutOs V1.0
12 await redis . quit () ;
13 }) ;
14
15 // Test 1: Same request twice same response
16 it ( ’ should return same response for duplicate request ’ , async
() = > {
17 const idempotencyKey = ’123 e4567 - e89b -12 d3 - a456
-426614174001 ’;
18 const paymentData = {
19 amount : 50000 ,
20 currency : ’INR ’ ,
21 orderId : ‘ order_$ { Date . now () } ‘ ,
22 description : ’ Test payment ’
23 };
24
25 const response1 = await request ( app )
26 . post ( ’/ payments ’)
27 . set ( ’ Idempotency - Key ’ , idempotencyKey )
28 . send ( paymentData ) ;
29
30 const response2 = await request ( app )
31 . post ( ’/ payments ’)
32 . set ( ’ Idempotency - Key ’ , idempotencyKey )
33 . send ( paymentData ) ;
34
35 expect ( response1 . status ) . toBe (200) ;
36 expect ( response2 . status ) . toBe (200) ;
37 expect ( response1 . body . data . paymentId ) . toBe ( response2 . body .
data . paymentId ) ;
38 }) ;
39
40 // Test 2: Different payload same key error
41 it ( ’ should reject different payload with same key ’ , async () = >
{
42 const idempotencyKey = ’123 e4567 - e89b -12 d3 - a456
-426614174003 ’;
43
44 await request ( app )
45 . post ( ’/ payments ’)
46 . set ( ’ Idempotency - Key ’ , idempotencyKey )
47 . send ({
48 amount : 50000 ,
49 currency : ’INR ’ ,
50 orderId : ’ order_456 ’ ,
51 description : ’ First payload ’
52 }) ;
53
54 const response = await request ( app )
55 . post ( ’/ payments ’)
56 . set ( ’ Idempotency - Key ’ , idempotencyKey )
57 . send ({
34
Idempotency Implementation Plan checkoutOs V1.0
58 amount : 100000 ,
59 currency : ’INR ’ ,
60 orderId : ’ order_789 ’ ,
61 description : ’ Different payload ’
62 }) ;
63
64 expect ( response . status ) . toBe (400) ;
65 expect ( response . body . error . code ) . toBe ( ’ IDEMPOTENCY_KEY_REUSED
’) ;
66 }) ;
67
68 // Test 3: Parallel requests one success , one 409
69 it ( ’ should return 409 for parallel requests with same key ’ ,
async () = > {
70 const idempotencyKey = ’123 e4567 - e89b -12 d3 - a456
-426614174002 ’;
71 const paymentData = {
72 amount : 50000 ,
73 currency : ’INR ’ ,
74 orderId : ‘ order_$ { Date . now () } ‘ ,
75 description : ’ Test payment ’
76 };
77
78 const [ response1 , response2 ] = await Promise . all ([
79 request ( app ) . post ( ’/ payments ’) . set ( ’ Idempotency - Key ’ ,
idempotencyKey ) . send ( paymentData ) ,
80 request ( app ) . post ( ’/ payments ’) . set ( ’ Idempotency - Key ’ ,
idempotencyKey ) . send ( paymentData )
81 ]) ;
82
83 const successResponse = response1 . status === 200 ? response1
: response2 ;
84 const conflictResponse = response1 . status === 409 ? response1
: response2 ;
85
86 expect ( successResponse . status ) . toBe (200) ;
87 expect ( conflictResponse . status ) . toBe (409) ;
88 expect ( conflictResponse . body . error . code ) . toBe ( ’
REQUEST_IN_PROGRESS ’) ;
89 }) ;
90
91 // Test 4: Missing header 400
92 it ( ’ should reject request without Idempotency - Key header ’ ,
async () = > {
93 const response = await request ( app )
94 . post ( ’/ payments ’)
95 . send ({
96 amount : 50000 ,
97 currency : ’INR ’ ,
98 orderId : ’ order_123 ’
99 }) ;
35
Idempotency Implementation Plan checkoutOs V1.0
100
101 expect ( response . status ) . toBe (400) ;
102 expect ( response . body . error . code ) . toBe ( ’
MISSING_IDEMPOTENCY_KEY ’) ;
103 }) ;
104
105 // Test 5: Invalid UUID format 400
106 it ( ’ should reject request with invalid UUID format ’ , async ()
= > {
107 const response = await request ( app )
108 . post ( ’/ payments ’)
109 . set ( ’ Idempotency - Key ’ , ’not -a - uuid ’)
110 . send ({
111 amount : 50000 ,
112 currency : ’INR ’ ,
113 orderId : ’ order_123 ’
114 }) ;
115
116 expect ( response . status ) . toBe (400) ;
117 expect ( response . body . error . code ) . toBe ( ’
INVALID_IDEMPOTENCY_KEY ’) ;
118 }) ;
119
120 // Test 6: Different amount same orderId error ( FIX Issue
6)
121 it ( ’ should reject different amount with same orderId ’ , async ()
= > {
122 const orderId = ‘ order_$ { Date . now () } ‘;
123 const idempotencyKey = ’123 e4567 - e89b -12 d3 - a456
-426614174004 ’;
124
125 // First request with amount 50000
126 await request ( app )
127 . post ( ’/ payments ’)
128 . set ( ’ Idempotency - Key ’ , idempotencyKey )
129 . send ({
130 amount : 50000 ,
131 currency : ’INR ’ ,
132 orderId : orderId ,
133 description : ’ First payment ’
134 }) ;
135
136 // Second request with different amount (100000) but same
orderId
137 const response = await request ( app )
138 . post ( ’/ payments ’)
139 . set ( ’ Idempotency - Key ’ , ’123 e4567 - e89b -12 d3 - a456
-426614174005 ’)
140 . send ({
141 amount : 100000 ,
142 currency : ’INR ’ ,
36
Idempotency Implementation Plan checkoutOs V1.0
143 orderId : orderId ,
144 description : ’ Different amount ’
145 }) ;
146
147 expect ( response . status ) . toBe (409) ;
148 expect ( response . body . error . code ) . toBe ( ’
ORDER_ID_AMOUNT_MISMATCH ’) ;
149 }) ;
150 }) ;
Step 10.5Step 8.5: Test Checklist
Test Case Status
Same request twice → same
response
Integration test
Different payload same key
→ error
Integration test
Parallel requests → one success, one 409
Integration test
Crash simulation → fallback via orderId
Integration test
Stale IN PROGRESS →
auto-recovery
Unit test
Different amount same orderId → error
Integration test
Different currency same orderId → error
Integration test
37
Idempotency Implementation Plan checkoutOs V1.0
Phase 11: Documentation
Handbook Reference: Section 2.7 - ”Documentation is not optional in checkoutOs.”
Step 11.1Step 9.1: Create ADR
File: docs/adr/001-idempotency.md (NEW)
1 # ADR 001: Idempotency Implementation
2
3 ## Status
4 Accepted - 2024 -01 -15
5
6 ## Context
7 Payment creation endpoints must be idempotent to prevent
duplicate charges from :
8 - Network retries
9 - Double - clicks on payment buttons
10 - Browser refresh after payment
11 - Mobile app re - submission
12
13 ## Decision
14 Implement idempotency using Option A ( Pure Service Layer ) where :
15
16 1. ** Middleware ** extracts ‘ Idempotency - Key ‘ header , validates
UUID format ,
17 generates request hash , and attaches to ‘ req . idempotency ‘
18 2. ** Middleware does NOT ** call services or access Redis
19 3. ** IdempotencyService ** handles all business logic ( check ,
complete , race conditions )
20 4. ** PaymentService ** orchestrates idempotency check payment
creation idempotency complete
21 5. ** IdempotencyStore ** is the ONLY layer accessing Redis
22 6. ** Redis ** stores records with ‘ chk : idem :{ key } ‘ pattern , 24 h
TTL ,
23 using ‘ SET NX ‘ for atomicity
24
25 ## Production Fixes Applied
26
27 | Issue | Fix |
28 | - - - - - - -| - - - - -|
29 | Stale IN_PROGRESS | 30 - second timeout with auto - recovery |
30 | complete () failure | Never fails response , logs error |
31 | orderId mismatch | Amount / currency validation |
32 | Race condition | Iterative retry with limit |
33 | Update atomicity | Lua script for atomic updates |
34
35 ## Consequences
36
37 ### Positive
38 - Respects handbook layer boundaries ( Section 4.2 , 5.5 , 5.7)
38
Idempotency Implementation Plan checkoutOs V1.0
39 - Single source of truth for idempotency logic
40 - Easy to test ( each layer independently )
41 - OrderId dedup provides crash recovery ( Section 10.1)
42
43 ### Negative
44 - Slightly higher latency ( controller + service call before
rejection )
45 - Additional service dependency
46
47 ## Alternatives Considered
48
49 ### Option B ( Middleware calls service )
50 Rejected because :
51 - Violates Section 5.7 ( controllers call services , not middleware
)
52 - Violates Section 5.5 ( middleware would need Redis access )
53 - Creates slippery slope for auth , rate limiting middleware
54
55 ### No idempotency
56 Rejected because duplicate payments are unacceptable for
production
57
58 ## Related
59 - Handbook Section 4.2 - Layer Architecture
60 - Handbook Section 5.5 - Store Layer
61 - Handbook Section 5.7 - Services Layer
62 - Handbook Section 12 - Testing Checklist
Step 11.2Step 9.2: Update OpenAPI Documentation
File: docs/openapi.yaml (MODIFY)
1 paths :
2 / payments :
3 post :
4 summary : Create a new payment
5 description : |
6 Creates a redirect - based payment . This endpoint is
idempotent .
7 Same Idempotency - Key + same payload same response .
8 Same Idempotency - Key + different payload 400 error .
9 parameters :
10 - name : Idempotency - Key
11 in: header
12 required : true
13 schema :
14 type : string
15 format : uuid
16 example : "123 e4567 -e89b -12d3 -a456 -426614174000 "
17 description : |
18 UUID v4 key for idempotent requests .
39
Idempotency Implementation Plan checkoutOs V1.0
19 Store this key to retrieve the same response on
retries .
20 responses :
21 ’200 ’:
22 description : Payment created successfully or previously
completed
23 content :
24 application / json :
25 schema :
26 $ref : ’#/ components / schemas / PaymentResponse ’
27 ’400 ’:
28 description : |
29 - MISSING_IDEMPOTENCY_KEY : Header not provided
30 - INVALID_IDEMPOTENCY_KEY : Not a valid UUID
31 - IDEMPOTENCY_KEY_REUSED : Same key with different
payload
32 ’409 ’:
33 description : |
34 - REQUEST_IN_PROGRESS : Another request with same key
is processing
35 - ORDER_ID_AMOUNT_MISMATCH : OrderId exists with
different amount
36 - ORDER_ID_CURRENCY_MISMATCH : OrderId exists with
different currency
40
Idempotency Implementation Plan checkoutOs V1.0
Phase 12: Dependencies
Step 12.1Step 10.1: Install Required Packages
1 npm install uuid
2 npm install -- save - dev @types / uuid
Step 12.2Step 10.2: Verify Existing Dependencies
Per Section 1.4 tech stack, these already exist:
• express
• ioredis
• typescript (strict mode)
• jest (testing)
• winston (logging)
41
Idempotency Implementation Plan checkoutOs V1.0
Phase 13: Implementation Checklist
Phase Task Files Status
1 Add idempotency types src/types/common.types.ts
1 Create express types src/types/express.types.ts
1 Create idempotency errors src/errors/idempotency.errors.ts
1 Create orderId mismatch errors src/errors/payment.errors.ts
2 Create idempotency store (with
Lua)
src/store/idempotency.store.ts
3 Create idempotency service src/services/idempotency.service.ts
3 Modify payment service src/services/payment.service.ts
4 Create idempotency middleware src/middleware/idempotency.middleware.ts
5 Modify payment controller src/controllers/payment.controller.ts
6 Register middleware on route src/app.ts or routes
file
7 Verify time utility src/utils/time.ts
8 Create store unit tests tests/unit/store/idempotency.store.test.ts
8 Create service unit tests tests/unit/services/idempotency.service.test.ts
8 Create stale tests tests/unit/services/idempotency.service.stale.test.ts
8 Create integration tests tests/integration/idempotency.test.ts
9 Create ADR docs/adr/001-
idempotency.md
9 Update OpenAPI docs/openapi.yaml
10 Install dependencies package.json
42
Idempotency Implementation Plan checkoutOs V1.0
Phase 14: Summary of Files
Step 14.1Files to CREATE
src/types/express.types.ts
src/errors/idempotency.errors.ts
src/store/idempotency.store.ts
src/services/idempotency.service.ts
src/middleware/idempotency.middleware.ts
src/utils/hash.ts (optional)
tests/unit/store/idempotency.store.test.ts
tests/unit/services/idempotency.service.test.ts
tests/unit/services/idempotency.service.stale.test.ts
tests/integration/idempotency.test.ts
docs/adr/001-idempotency.md
Step 14.2Files to MODIFY
src/types/common.types.ts (add idempotency types and constants)
src/errors/payment.errors.ts (add OrderId mismatch errors)
src/services/payment.service.ts (add createPaymentWithIdempotency method)
src/controllers/payment.controller.ts (update to use req.idempotency)
src/app.ts or routes file (add middleware to route)
docs/openapi.yaml (add Idempotency-Key header spec)
package.json (add uuid dependencies)
Step 14.3Files to VERIFY (already exist)
src/store/redis.client.ts (per Section 3.4)
src/utils/time.ts (per Section 3.4)
src/errors/app.errors.ts (AppError base class)
src/utils/logger.ts (Winston logger)
43
Idempotency Implementation Plan checkoutOs V1.0
Phase 15: Production Readiness Checklist
Before deploying to production, verify:
Check Status
All tests pass (unit + integration)
Stale IN PROGRESS recovery tested
complete() failure does not
break response
orderId amount mismatch
returns 409
orderId currency mismatch
returns 409
Redis atomic operations
verified
Logging structured and
searchable
No barrel files (direct imports only)
TypeScript strict mode
passes
ESLint passes (no any, no
floating promises)
TTL set to 24 hours
Health check includes Redis
Phase 16: Final Note
NO BARREL FILES (index.ts with re-exports) are created or modified. All imports
use direct paths per handbook Section 2.1 (no default exports).
All critical issues from code review have been addressed:
• Issue 2: Structured logging added
• Issue 3: Race condition with iterative retry
• Issue 4: Atomic Lua script for updates
• Issue 5: complete() failure handling
• Issue 6: orderId amount/currency validation
• Issue 7: Stale IN PROGRESS detection (30s)
• Issue 8: Merchant namespace (deferred to V1.2)
• Issue 9: Metrics (deferred to V1.2 per handbook Section 10)
44
Idempotency Implementation Plan checkoutOs V1.0
End of Implementation Plan
45