import { useEffect, useRef, useState } from 'react';
import type { Footprint, LivePriceResponse } from '@internal/nebius-domain';
import { useBackend } from '../../ui/api';
import { failureState, LivePriceState, pendingState } from './livePrice';

export const FOOTPRINT_KEYS = ['min', 'expected', 'max'] as const;
export type FootprintKey = (typeof FOOTPRINT_KEYS)[number];

export interface FootprintPricingInput {
  footprints: Record<FootprintKey, Footprint>;
  region?: string;
  capacityType?: 'on-demand' | 'reserved' | 'preemptible';
}

const idle = (message?: string): Record<FootprintKey, LivePriceState> => ({ min: { status: 'idle', message }, expected: { status: 'idle', message }, max: { status: 'idle', message } });

/**
 * States when a pricing round starts. New footprints drop the previous prices (they belong to other inputs);
 * a retry of the same footprints keeps them on screen, marked as updating.
 */
export function restartedStates(prev: Record<FootprintKey, LivePriceState>, sameFootprints: boolean): Record<FootprintKey, LivePriceState> {
  const next = (s: LivePriceState): LivePriceState => (sameFootprints ? pendingState(s) : { status: 'loading' });
  return { min: next(prev.min), expected: next(prev.expected), max: next(prev.max) };
}

/**
 * Live prices (POST /pricing/footprint) for a scenario's three footprints.
 * Requests wait `delay` ms after the last edit; replies to older inputs are dropped, and prices of
 * earlier footprints are never shown for new ones.
 */
export function useFootprintLivePrices(input: FootprintPricingInput | undefined, delay = 500): { states: Record<FootprintKey, LivePriceState>; reload: () => void } {
  const call = useBackend();
  const [states, setStates] = useState<Record<FootprintKey, LivePriceState>>(() => idle());
  const [tick, setTick] = useState(0);
  const seq = useRef(0);
  const priced = useRef<string | null>(null);
  const key = input ? JSON.stringify({ footprints: input.footprints, region: input.region, capacityType: input.capacityType }) : null;

  useEffect(() => {
    const mine = ++seq.current;
    if (key === null) {
      setStates(idle('No scenario footprint to price.'));
      return undefined;
    }
    const same = priced.current === key;
    priced.current = key;
    setStates(s => restartedStates(s, same));
    const body = JSON.parse(key) as FootprintPricingInput;
    const t = setTimeout(() => {
      for (const fp of FOOTPRINT_KEYS) {
        call<LivePriceResponse>('/pricing/footprint', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ footprint: body.footprints[fp], region: body.region, capacityType: body.capacityType }),
        })
          .then(response => {
            if (mine === seq.current) setStates(s => ({ ...s, [fp]: { status: 'ready', response } }));
          })
          .catch(e => {
            if (mine === seq.current) setStates(s => ({ ...s, [fp]: failureState(e) }));
          });
      }
    }, delay);
    return () => clearTimeout(t);
  }, [key, call, delay, tick]);

  return { states, reload: () => setTick(t => t + 1) };
}
