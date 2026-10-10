//! pocket-voxel 3DS host for the gen3 (FireRed) port (GPLv3 + additional
//! terms; see LICENSE.md). The FireRed build's allocator: the host's big
//! blocks -- pak read buffers, cached paks, read-aheads, the terrain
//! texture's pixels, each 0.5 to 3 MB -- in a region of their own, set
//! apart from the app heap early in the boot; everything else (and a big
//! block the region cannot take) goes to newlib's malloc as before.
//!
//! A pak read wants one block of the pak's size. Late in a long session the
//! app heap's free part was all in pieces -- the leak bench's tour: 21 MB
//! free, no block of 2.4 MB -- because the many small blocks QuickJS and the
//! host keep for good had settled in the holes the paks left: the next
//! map's pak could not be read and its world was never built. In a region
//! only big blocks use, a block let go leaves a hole only big blocks fill.
//!
//! The region is one malloc'd block, carved first-fit from a short list of
//! free ranges (merged when they touch); every operation takes a spin lock.

use core::alloc::{GlobalAlloc, Layout};
use core::sync::atomic::{AtomicBool, Ordering};
use std::alloc::System;

/// Blocks at least this big go to the region (when it can take them).
const BIG: usize = 512 * 1024;
const ALIGN: usize = 16;
const MAX_FREE: usize = 64;

struct Region {
    base: usize,
    size: usize,
    /// Free ranges (offset, length), sorted by offset, `nfree` of them.
    free: [(usize, usize); MAX_FREE],
    nfree: usize,
    used: usize,
}

static mut REGION: Region = Region { base: 0, size: 0, free: [(0, 0); MAX_FREE], nfree: 0, used: 0 };
static LOCK: AtomicBool = AtomicBool::new(false);

fn lock() {
    while LOCK.compare_exchange_weak(false, true, Ordering::Acquire, Ordering::Relaxed).is_err() {
        core::hint::spin_loop();
    }
}
fn unlock() {
    LOCK.store(false, Ordering::Release);
}
fn round(n: usize) -> usize {
    (n + ALIGN - 1) & !(ALIGN - 1)
}

impl Region {
    fn contains(&self, p: usize) -> bool {
        self.size > 0 && p >= self.base && p < self.base + self.size
    }
    fn take(&mut self, len: usize) -> Option<usize> {
        let len = round(len);
        for i in 0..self.nfree {
            let (off, l) = self.free[i];
            if l >= len {
                if l == len {
                    self.free.copy_within(i + 1..self.nfree, i);
                    self.nfree -= 1;
                } else {
                    self.free[i] = (off + len, l - len);
                }
                self.used += len;
                return Some(self.base + off);
            }
        }
        None
    }
    fn give(&mut self, p: usize, len: usize) {
        let (off, len) = (p - self.base, round(len));
        if len == 0 {
            return;
        }
        self.used -= len;
        let i = self.free[..self.nfree].partition_point(|r| r.0 < off);
        // merge with the range before and the one after when they touch
        let joins_prev = i > 0 && self.free[i - 1].0 + self.free[i - 1].1 == off;
        let joins_next = i < self.nfree && off + len == self.free[i].0;
        match (joins_prev, joins_next) {
            (true, true) => {
                self.free[i - 1].1 += len + self.free[i].1;
                self.free.copy_within(i + 1..self.nfree, i);
                self.nfree -= 1;
            }
            (true, false) => self.free[i - 1].1 += len,
            (false, true) => self.free[i] = (off, len + self.free[i].1),
            (false, false) => {
                if self.nfree == MAX_FREE {
                    // (never seen: a handful of big blocks live at once) the
                    // range is lost to the region rather than overrun the list
                    return;
                }
                self.free.copy_within(i..self.nfree, i + 1);
                self.free[i] = (off, len);
                self.nfree += 1;
            }
        }
    }
}

pub struct G3Alloc;

unsafe impl GlobalAlloc for G3Alloc {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        if layout.size() >= BIG && layout.align() <= ALIGN {
            lock();
            let p = (*core::ptr::addr_of_mut!(REGION)).take(layout.size());
            unlock();
            if let Some(p) = p {
                return p as *mut u8;
            }
        }
        System.alloc(layout)
    }
    unsafe fn alloc_zeroed(&self, layout: Layout) -> *mut u8 {
        if layout.size() >= BIG && layout.align() <= ALIGN {
            lock();
            let p = (*core::ptr::addr_of_mut!(REGION)).take(layout.size());
            unlock();
            if let Some(p) = p {
                core::ptr::write_bytes(p as *mut u8, 0, layout.size());
                return p as *mut u8;
            }
        }
        System.alloc_zeroed(layout)
    }
    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        lock();
        let r = &mut *core::ptr::addr_of_mut!(REGION);
        if r.contains(ptr as usize) {
            r.give(ptr as usize, layout.size());
            unlock();
            return;
        }
        unlock();
        System.dealloc(ptr, layout)
    }
    unsafe fn realloc(&self, ptr: *mut u8, layout: Layout, new_size: usize) -> *mut u8 {
        lock();
        let r = &mut *core::ptr::addr_of_mut!(REGION);
        let inside = r.contains(ptr as usize);
        if inside && round(new_size) <= round(layout.size()) {
            // shrinking in place: the tail goes back to the region
            r.give(ptr as usize + round(new_size), round(layout.size()) - round(new_size));
            unlock();
            return ptr;
        }
        unlock();
        if !inside && new_size < BIG {
            return System.realloc(ptr, layout, new_size);
        }
        let new_layout = Layout::from_size_align_unchecked(new_size, layout.align());
        let q = self.alloc(new_layout);
        if !q.is_null() {
            core::ptr::copy_nonoverlapping(ptr, q, layout.size().min(new_size));
            self.dealloc(ptr, layout);
        }
        q
    }
}

/// Set the region apart (before_guest: after the boot's own reads, before
/// the guest's load fills the heap). Nothing when the heap will not give it.
pub fn region_init(bytes: usize) -> bool {
    let layout = match Layout::from_size_align(bytes, ALIGN) { Ok(l) => l, Err(_) => return false };
    let p = unsafe { System.alloc(layout) };
    if p.is_null() {
        return false;
    }
    lock();
    unsafe {
        let r = &mut *core::ptr::addr_of_mut!(REGION);
        r.base = p as usize;
        r.size = bytes;
        r.free[0] = (0, bytes);
        r.nfree = 1;
        r.used = 0;
    }
    unlock();
    true
}

/// The region: (size, in use, largest free range), bytes.
pub fn region_stats() -> (usize, usize, usize) {
    lock();
    let r = unsafe { &*core::ptr::addr_of!(REGION) };
    let big = r.free[..r.nfree].iter().map(|f| f.1).max().unwrap_or(0);
    let s = (r.size, r.used, big);
    unlock();
    s
}
