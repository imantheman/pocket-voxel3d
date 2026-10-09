/* pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
   terms; see LICENSE.md). The process heaps, for the Gen 3 build only.

   libctru's __system_allocateHeaps (weak; this one replaces it) sizes the
   app heap as "what the resource limit says is free" minus the linear heap,
   asks for exactly that, and svcBreaks if the kernel says no. On a real
   console the limit's figure is optimistic under the Homebrew Launcher and
   FBI -- a 98 MB ask failed there (crash in __system_allocateHeaps, build
   210813) where Citra granted it. So: the same sizing, then on a refusal
   the ask steps down 1 MB at a time until the kernel grants it. The linear
   heap keeps its fixed size (it is asked for second, out of what is left;
   if that fails, app heap is handed back 1 MB at a time until it fits).
   g3_heap_info() reports what was asked and what was granted, for pvlog. */

#include <3ds.h>

extern u32 __ctru_heap, __ctru_heap_size, __ctru_linear_heap, __ctru_linear_heap_size;
extern char *fake_heap_start, *fake_heap_end;
void mappableInit(u32 addrMin, u32 addrMax);

#define HEAP_STEP 0x100000u
#define HEAP_MIN  (32u * 1024u * 1024u)

static u32 asked_heap, got_heap, steps;

void __system_allocateHeaps(void) {
    Handle reslimit = 0;
    if (R_FAILED(svcGetResourceLimit(&reslimit, CUR_PROCESS_HANDLE))) svcBreak(USERBREAK_PANIC);
    ResourceLimitType type = RESLIMIT_COMMIT;
    s64 maxCommit = 0, curCommit = 0;
    svcGetResourceLimitLimitValues(&maxCommit, reslimit, &type, 1);
    svcGetResourceLimitCurrentValues(&curCommit, reslimit, &type, 1);
    svcCloseHandle(reslimit);
    u32 remaining = (u32)(maxCommit - curCommit) & ~0xFFFu;

    u32 lin = __ctru_linear_heap_size;
    if (lin + HEAP_MIN > remaining) svcBreak(USERBREAK_PANIC);
    u32 heap = __ctru_heap_size ? __ctru_heap_size : remaining - lin;
    asked_heap = heap;

    /* the app heap: step down until the kernel grants it */
    for (;;) {
        if (R_SUCCEEDED(svcControlMemory(&__ctru_heap, OS_HEAP_AREA_BEGIN, 0x0, heap,
                                         MEMOP_ALLOC, MEMPERM_READ | MEMPERM_WRITE))) break;
        if (heap < HEAP_MIN + HEAP_STEP) svcBreak(USERBREAK_PANIC);
        heap -= HEAP_STEP;
        steps++;
    }

    /* the linear heap at its fixed size: hand app heap back if it will not fit */
    for (;;) {
        if (R_SUCCEEDED(svcControlMemory(&__ctru_linear_heap, 0x0, 0x0, lin,
                                         MEMOP_ALLOC_LINEAR, MEMPERM_READ | MEMPERM_WRITE))) break;
        if (heap < HEAP_MIN + HEAP_STEP) svcBreak(USERBREAK_PANIC);
        u32 out;
        heap -= HEAP_STEP;
        svcControlMemory(&out, __ctru_heap + heap, 0x0, HEAP_STEP, MEMOP_FREE, 0);
        steps++;
    }

    __ctru_heap_size = heap;
    got_heap = heap;
    mappableInit(OS_MAP_AREA_BEGIN, OS_MAP_AREA_END);
    fake_heap_start = (char *)__ctru_heap;
    fake_heap_end = fake_heap_start + __ctru_heap_size;
}

/* what the start asked for and got (KB), and how many 1 MB steps it took */
void g3_heap_info(u32 *asked_kb, u32 *got_kb, u32 *nsteps) {
    *asked_kb = asked_heap >> 10;
    *got_kb = got_heap >> 10;
    *nsteps = steps;
}
