/* Noise cancellation of the microphone: RNNoise (rnnoise/), 10 ms at a time. */
#ifndef ADDA_NOISE_CORE_H
#define ADDA_NOISE_CORE_H

typedef struct NoiseCanceller NoiseCanceller;

NoiseCanceller *nc_create(void);
void nc_destroy(NoiseCanceller *nc);

/*
 * Cleans 10 ms of mono sound in place: `frames` samples (so a rate of
 * frames * 100 Hz), as floats on the 16-bit scale (as WebRTC hands them over).
 * RNNoise works at 48 kHz; other rates (16 or 32 kHz, 44.1 kHz) are converted
 * there and back. Returns how sure RNNoise is that someone's speaking (0 to 1),
 * or -1 for a buffer it can't take (left as it was).
 */
float nc_process(NoiseCanceller *nc, float *buf, int frames);

#endif
