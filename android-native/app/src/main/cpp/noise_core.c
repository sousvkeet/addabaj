#include "noise_core.h"

#include <math.h>
#include <stdlib.h>
#include <string.h>

#include "rnnoise.h"

/* RNNoise's frame: 10 ms at 48 kHz. */
#define FRAME 480

struct NoiseCanceller {
    DenoiseState *st;
    float in[FRAME];
    float out[FRAME];
    /* The last sample of the previous 10 ms (before, and after, at 48 kHz), so converted
       rates join up smoothly from one buffer to the next. */
    float prev_in;
    float prev_out;
};

NoiseCanceller *nc_create(void) {
    NoiseCanceller *nc = calloc(1, sizeof(NoiseCanceller));
    if (!nc) return NULL;
    nc->st = rnnoise_create(NULL);
    if (!nc->st) {
        free(nc);
        return NULL;
    }
    return nc;
}

void nc_destroy(NoiseCanceller *nc) {
    if (!nc) return;
    rnnoise_destroy(nc->st);
    free(nc);
}

/*
 * Linear conversion of n_in samples to n_out over the same 10 ms, one input
 * sample late: out[i] is the input at i * n_in / n_out - 1, where in[-1] is
 * `prev` (the last sample of the buffer before), so nothing is missing at the
 * buffer's end.
 */
static void convert(const float *in, int n_in, float prev, float *out, int n_out) {
    for (int i = 0; i < n_out; i++) {
        float pos = (float)i * (float)n_in / (float)n_out - 1.0f;
        int k = (int)floorf(pos);
        float f = pos - (float)k;
        float a = k < 0 ? prev : in[k];
        float b = in[k + 1];
        out[i] = a + (b - a) * f;
    }
}

float nc_process(NoiseCanceller *nc, float *buf, int frames) {
    if (!nc || !buf || frames < 80 || frames > FRAME) return -1.0f;
    float vad;
    if (frames == FRAME) {
        memcpy(nc->in, buf, sizeof(nc->in));
        vad = rnnoise_process_frame(nc->st, nc->out, nc->in);
        memcpy(buf, nc->out, sizeof(nc->out));
    } else {
        convert(buf, frames, nc->prev_in, nc->in, FRAME);
        nc->prev_in = buf[frames - 1];
        vad = rnnoise_process_frame(nc->st, nc->out, nc->in);
        convert(nc->out, FRAME, nc->prev_out, buf, frames);
        nc->prev_out = nc->out[FRAME - 1];
    }
    return vad;
}
