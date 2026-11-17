import React from 'react';

export type CrowSigilTone = 'auto' | 'dark' | 'light' | 'indigo' | 'custom';
export type CrowSigilDetail = 'full' | 'compact';

interface CrowSigilProps {
  size?: number | string;
  tone?: CrowSigilTone;
  detail?: CrowSigilDetail;
  bodyColor?: string;
  inkColor?: string;
  className?: string;
  'aria-hidden'?: boolean;
  'aria-label'?: string;
}

/**
 * Vector Crow Sigil derived from the CrowdOS brand reference sheets.
 * Perched vigilant posture (body facing right, head turned left) with
 * articulated wing coverts, tail feathers, beak line, eye, and talons.
 *
 * Dark & light modes are pure color inversions:
 *  - dark surface  -> white silhouette (#FAFAFA) with dark feather ink (#0B0B0E)
 *  - light surface -> obsidian silhouette (#0B0B0E) with paper feather ink (#FAFAFA)
 *  - auto          -> bound to CSS tokens --crow-body / --crow-ink
 */
export function CrowSigil({
  size = 32,
  tone = 'auto',
  detail = 'full',
  bodyColor,
  inkColor,
  className = '',
  'aria-hidden': ariaHidden = true,
  'aria-label': ariaLabel,
}: CrowSigilProps) {
  let fillBody = bodyColor;
  let strokeInk = inkColor;

  if (!fillBody || !strokeInk) {
    switch (tone) {
      case 'dark':
        fillBody = fillBody ?? '#FAFAFA';
        strokeInk = strokeInk ?? '#0B0B0E';
        break;
      case 'light':
        fillBody = fillBody ?? '#0B0B0E';
        strokeInk = strokeInk ?? '#FAF8F4';
        break;
      case 'indigo':
        fillBody = fillBody ?? '#FFFFFF';
        strokeInk = strokeInk ?? '#434FE6';
        break;
      case 'custom':
        fillBody = fillBody ?? 'currentColor';
        strokeInk = strokeInk ?? 'var(--crow-ink, #0B0B0E)';
        break;
      case 'auto':
      default:
        fillBody = fillBody ?? 'var(--crow-body, #FAFAFA)';
        strokeInk = strokeInk ?? 'var(--crow-ink, #0B0B0E)';
        break;
    }
  }

  const numericSize = typeof size === 'number' ? size : 32;
  const strokeScale =
    detail === 'compact'
      ? 2.5
      : numericSize < 38
        ? 2.1
        : numericSize < 90
          ? 1.4
          : 1;
  const sw = (base: number) => Number((base * strokeScale).toFixed(2));

  return (
    <svg
      viewBox="4 26 480 480"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      aria-hidden={ariaLabel ? undefined : ariaHidden}
      role={ariaLabel ? 'img' : undefined}
      aria-label={ariaLabel}
    >
      <g id="crow-sigil">
        {/* Main silhouette: body, wings, tail, head, and talons */}
        <path
          fill={fillBody}
          d="
            M 300 66
            C 316 55, 342 54, 366 64
            C 402 80, 424 115, 423 162
            C 422 175, 420 185, 422 195
            C 428 225, 420 265, 396 298
            C 378 320, 358 334, 341 344
            L 333 386
            L 372 429
            C 380 436, 392 440, 402 438
            C 412 435, 421 437, 427 444
            C 428 446, 426 447, 424 446
            C 417 441, 408 441, 399 442
            C 407 442, 415 443, 421 446
            C 421 447, 419 447, 416 447
            C 408 446, 401 446, 395 444
            C 382 448, 365 449, 353 445
            C 347 443, 342 444, 338 446
            C 337 446, 338 443, 341 440
            C 344 437, 351 437, 357 438
            C 361 438, 362 435, 358 430
            L 322 390
            L 308 383
            L 307 355
            C 307 346, 315 338, 322 332
            C 308 340, 294 349, 284 358
            L 284 385
            L 320 429
            C 326 436, 333 438, 341 439
            C 340 442, 336 445, 331 446
            C 320 448, 309 447, 299 444
            C 295 443, 291 444, 288 446
            C 287 446, 288 443, 291 440
            C 295 437, 301 436, 304 435
            C 306 434, 305 431, 302 427
            L 272 392
            L 260 385
            L 266 373
            C 235 397, 202 420, 172 438
            L 188 408
            L 193 398
            C 162 422, 134 446, 111 463
            C 95 473, 76 479, 63 477
            C 59 476, 59 473, 61 469
            C 69 452, 88 424, 108 398
            C 116 388, 125 381, 135 375
            L 126 377
            L 146 346
            L 120 351
            L 155 312
            L 186 280
            C 210 245, 240 206, 267 180
            C 281 167, 297 156, 313 150
            C 311 146, 308 143, 306 141
            C 306 116, 286 98, 250 86
            C 242 84, 234 83, 226 84
            C 226 81, 231 76, 243 71
            C 262 63, 282 62, 300 66 Z
          "
        />

        {/* Interior ink lines & feather contours */}
        <g fill="none" stroke={strokeInk} strokeLinecap="round" strokeLinejoin="round">
          {/* Upper & lower beak separation */}
          <path strokeWidth={sw(2.2)} d="M 234 80 C 254 76, 276 75, 299 77" />
          {detail === 'full' && (
            <path strokeWidth={sw(1.8)} d="M 300 66 C 298 71, 298 76, 301 80" />
          )}

          {/* Brow & Eye */}
          <path strokeWidth={sw(2.5)} d="M 301 77 C 310 76, 320 77, 329 79" />
          <path
            fill={strokeInk}
            stroke="none"
            d="
              M 304 77
              C 303 83, 307 88, 313 88
              C 318 88, 321 83, 320 78 Z
            "
          />
          {detail === 'full' && (
            <circle cx="308" cy="80" r="1.4" fill={fillBody} stroke="none" />
          )}

          {/* Back & shoulder contour */}
          <path strokeWidth={sw(2.2)} d="M 369 102 C 397 125, 415 162, 416 205" />
          <path strokeWidth={sw(2.2)} d="M 422 190 C 416 232, 396 266, 367 288" />

          {/* Main upper wing coverts */}
          <path
            strokeWidth={sw(2.5)}
            d="
              M 285 184
              C 312 162, 352 162, 366 188
              C 377 209, 367 239, 340 258
              C 295 292, 232 332, 135 375
            "
          />

          {/* Primary wing & tail divider */}
          <path strokeWidth={sw(2.2)} d="M 155 312 C 218 286, 280 252, 326 213" />
          <path strokeWidth={sw(2.4)} d="M 171 398 C 232 365, 295 319, 344 267" />

          {detail === 'full' && (
            <>
              {/* Chin feather accents */}
              <path strokeWidth={sw(1.5)} d="M 311 142 C 317 137, 325 137, 330 142" />
              <path strokeWidth={sw(1.4)} d="M 313 145 C 319 140, 326 140, 331 145" />
              <path strokeWidth={sw(1.4)} d="M 314 148 C 320 144, 327 144, 332 147" />

              {/* Inner shoulder & fine back accents */}
              <path strokeWidth={sw(1.6)} d="M 402 194 C 409 205, 413 218, 412 232" />
              <path strokeWidth={sw(1.2)} d="M 380 189 L 384 199 M 381 189 L 388 196" />
              <path strokeWidth={sw(1.2)} d="M 406 179 L 410 189 M 409 176 L 413 187" />

              {/* Secondary & primary wing layers */}
              <path strokeWidth={sw(2.2)} d="M 213 243 C 238 234, 262 223, 281 209" />
              <path strokeWidth={sw(1.6)} d="M 150 318 C 162 311, 173 304, 183 297" />
              <path strokeWidth={sw(2.2)} d="M 183 351 C 204 340, 224 328, 243 314" />
              <path strokeWidth={sw(2.2)} d="M 243 333 C 269 306, 293 276, 307 248" />
              <path strokeWidth={sw(2.2)} d="M 288 308 C 316 282, 344 252, 351 220" />

              {/* Lower wing edge & tail feathers */}
              <path strokeWidth={sw(2.2)} d="M 193 398 C 248 364, 304 320, 349 271" />
              <path strokeWidth={sw(1.5)} d="M 245 362 C 253 355, 261 348, 268 341" />
              <path
                strokeWidth={sw(2.0)}
                d="
                  M 132 414
                  C 113 431, 97 448, 88 461
                  C 85 466, 89 468, 94 464
                  C 104 456, 114 445, 123 434
                "
              />
              <path strokeWidth={sw(2.0)} d="M 139 428 C 125 446, 112 462, 102 473" />
              <path strokeWidth={sw(2.0)} d="M 94 451 C 82 461, 71 470, 62 476" />
              <path strokeWidth={sw(1.8)} d="M 88 462 C 85 469, 82 474, 79 477" />
            </>
          )}
        </g>
      </g>
    </svg>
  );
}

interface CrowdOSWordmarkProps {
  height?: number;
  showOS?: boolean;
  tone?: 'auto' | 'dark' | 'light';
  className?: string;
}

/**
 * Geometric SVG wordmark matching the reference sheets:
 * `Crow` + electric cobalt `d` + `OS`.
 * Automatically inverts between dark and light themes via CSS tokens.
 */
export function CrowdOSWordmarkSvg({
  height = 20,
  showOS = true,
  tone = 'auto',
  className = '',
}: CrowdOSWordmarkProps) {
  const ink =
    tone === 'dark'
      ? '#FAFAFA'
      : tone === 'light'
        ? '#0B0B0E'
        : 'var(--crow-body, #FAFAFA)';
  const cobalt = 'var(--crow-accent, #4B55FF)';
  const viewWidth = showOS ? 202 : 132;

  return (
    <svg
      viewBox={`0 0 ${viewWidth} 38`}
      height={height}
      width={Math.round((height * viewWidth) / 38)}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={`shrink-0 ${className}`}
      role="img"
      aria-label={showOS ? 'Crowd OS' : 'Crowd'}
    >
      {/* C */}
      <path
        d="M 22 10 H 9.5 C 5.6 10 3.5 12.1 3.5 16 V 24 C 3.5 27.9 5.6 30 9.5 30 H 22"
        stroke={ink}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* r */}
      <path
        d="M 29.5 30 V 18.5 C 29.5 15.8 31.2 14.5 34 14.5 H 42.5"
        stroke={ink}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* o */}
      <rect
        x="48"
        y="14.5"
        width="18.5"
        height="15.5"
        rx="5.2"
        stroke={ink}
        strokeWidth="3.5"
      />
      {/* w */}
      <path
        d="M 73.5 14.5 L 78.2 29.5 C 78.5 30.2 79.3 30.2 79.7 29.5 L 85.4 17.5 C 85.7 16.9 86.5 16.9 86.8 17.5 L 92.5 29.5 C 92.9 30.2 93.7 30.2 94.0 29.5 L 98.7 14.5"
        stroke={ink}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      {/* d (Signature Cobalt) */}
      <path
        d="M 124 7 V 30 M 124 19.5 C 124 16.1 121.8 14.5 118.2 14.5 H 111.5 C 107.8 14.5 105.5 16.6 105.5 20.5 V 24 C 105.5 27.9 107.8 30 111.5 30 H 118.2 C 121.8 30 124 28.4 124 25"
        stroke={cobalt}
        strokeWidth="3.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {showOS && (
        <>
          {/* O */}
          <rect
            x="146"
            y="10"
            width="21"
            height="20"
            rx="5.8"
            stroke={ink}
            strokeWidth="3.5"
          />
          {/* S */}
          <path
            d="M 195.5 13.8 C 195.5 11.4 193.6 10 190.2 10 H 180.5 C 176.8 10 175 11.8 175 14.8 C 175 17.8 176.8 19.5 180.5 19.5 H 190.5 C 194.2 19.5 196 21.4 196 24.8 C 196 28.2 194.2 30 190.5 30 H 180.2 C 176.8 30 174.8 28.5 174.8 26"
            stroke={ink}
            strokeWidth="3.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )}
    </svg>
  );
}

interface CrowdOSLockupProps {
  layout?: 'horizontal' | 'stacked';
  tone?: 'auto' | 'dark' | 'light';
  size?: 'sm' | 'md' | 'lg';
  showTagline?: boolean;
  className?: string;
}

/**
 * Full Crowd OS Brand Lockup matching sections 4 & 5 of the Brand Sheet:
 *  - horizontal: [Crow Sigil] | [Crowd OS]
 *  - stacked:    [Crow Sigil] above [Crowd OS]
 */
export function CrowdOSLockup({
  layout = 'horizontal',
  tone = 'auto',
  size = 'md',
  showTagline = false,
  className = '',
}: CrowdOSLockupProps) {
  const dims = {
    sm: { sigil: 26, wordmark: 16, dividerH: 'h-6', gap: 'gap-2.5' },
    md: { sigil: 34, wordmark: 20, dividerH: 'h-8', gap: 'gap-3.5' },
    lg: { sigil: 48, wordmark: 26, dividerH: 'h-11', gap: 'gap-4' },
  }[size];

  if (layout === 'stacked') {
    return (
      <div className={`inline-flex flex-col items-center text-center select-none ${className}`}>
        <CrowSigil size={dims.sigil} tone={tone} detail="full" />
        <div className="mt-3">
          <CrowdOSWordmarkSvg height={dims.wordmark} tone={tone} />
        </div>
        {showTagline && (
          <p className="mt-2 text-[10px] font-mono uppercase tracking-[0.22em] text-zinc-500">
            Intelligence · Coordination · Impact
          </p>
        )}
      </div>
    );
  }

  return (
    <div className={`inline-flex items-center select-none ${dims.gap} ${className}`}>
      <CrowSigil size={dims.sigil} tone={tone} detail={dims.sigil <= 24 ? 'compact' : 'full'} />
      <span
        aria-hidden="true"
        className={`w-px ${dims.dividerH} bg-zinc-800 shrink-0`}
      />
      <div className="flex flex-col justify-center">
        <CrowdOSWordmarkSvg height={dims.wordmark} tone={tone} />
        {showTagline && (
          <span className="mt-1 text-[9.5px] font-mono uppercase tracking-[0.2em] text-zinc-500 whitespace-nowrap">
            Intelligence · Coordination · Impact
          </span>
        )}
      </div>
    </div>
  );
}
