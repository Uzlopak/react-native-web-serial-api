package dev.webserialapi;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/**
 * Pure-logic unit tests for {@link PortPickerActivity#matchesAnyFilter}. No
 * Android runtime is needed — this is the bug-prone part of the picker (vendor
 * id matching, the -1 product-id wildcard, and the mismatched-array-length
 * guard).
 */
public class PortFilterMatcherTest {

    private static final int FTDI_VID = 0x0403;
    private static final int FTDI_PID = 0x6001;

    @Test
    public void noFiltersMatchesEverything() {
        assertTrue(PortPickerActivity.matchesAnyFilter(FTDI_VID, FTDI_PID, null, null));
        assertTrue(PortPickerActivity.matchesAnyFilter(FTDI_VID, FTDI_PID, new int[0], new int[0]));
    }

    @Test
    public void matchesOnVendorAndProductId() {
        assertTrue(PortPickerActivity.matchesAnyFilter(
                FTDI_VID, FTDI_PID, new int[]{FTDI_VID}, new int[]{FTDI_PID}));
    }

    @Test
    public void productIdWildcardMatchesAnyProductOfThatVendor() {
        // -1 means "any product id for this vendor".
        assertTrue(PortPickerActivity.matchesAnyFilter(
                FTDI_VID, 0x9999, new int[]{FTDI_VID}, new int[]{-1}));
    }

    @Test
    public void rejectsWhenVendorDiffers() {
        assertFalse(PortPickerActivity.matchesAnyFilter(
                0x1234, FTDI_PID, new int[]{FTDI_VID}, new int[]{FTDI_PID}));
    }

    @Test
    public void rejectsWhenProductDiffersAndNotWildcard() {
        assertFalse(PortPickerActivity.matchesAnyFilter(
                FTDI_VID, 0x6015, new int[]{FTDI_VID}, new int[]{FTDI_PID}));
    }

    @Test
    public void matchesWhenAnyOneOfSeveralFiltersMatches() {
        int[] vids = {0x1234, FTDI_VID, 0x5678};
        int[] pids = {0x0001, FTDI_PID, 0x0002};
        assertTrue(PortPickerActivity.matchesAnyFilter(FTDI_VID, FTDI_PID, vids, pids));
    }

    @Test
    public void toleratesMismatchedArrayLengths() {
        // More vendor ids than product ids: only the overlapping prefix is
        // considered, and it must not throw ArrayIndexOutOfBoundsException.
        int[] vids = {FTDI_VID, 0x5678};
        int[] pids = {FTDI_PID};
        assertTrue(PortPickerActivity.matchesAnyFilter(FTDI_VID, FTDI_PID, vids, pids));
        assertFalse(PortPickerActivity.matchesAnyFilter(0x5678, 0x0002, vids, pids));
    }
}
