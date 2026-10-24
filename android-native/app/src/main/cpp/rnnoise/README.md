# RNNoise

[RNNoise](https://gitlab.xiph.org/xiph/rnnoise) 0.2 (April 2024) by Jean-Marc Valin and Xiph.Org, under the BSD licence in `COPYING`: the noise cancellation of calls and room voice (see `../noise_core.c`).

Only the library is here: its `src/` sources and `include/rnnoise.h`, with the default model in `src/rnnoise_data.c`. `src/vec.h`, `src/vec_neon.h` and `src/common.h` come from upstream commit 372f7b4 ("Fix compilation errors", the day after 0.2), which the ARM build needs; `src/x86/x86_arch_macros.h` is the one x86 header the sources include.
