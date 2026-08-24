package com.samaritantechs.hooploanlock;

import android.app.job.JobInfo;
import android.app.job.JobParameters;
import android.app.job.JobScheduler;
import android.app.job.JobService;
import android.content.ComponentName;
import android.content.Context;

/**
 * The clock. JobScheduler rather than an alarm or a foreground service, because it is the one
 * scheduler Android's battery management does not quietly kill -- and a lock that stops
 * checking in after two days of Doze is not a lock.
 *
 * Fifteen minutes is JobScheduler's floor for a periodic job and it is the right order of
 * magnitude anyway: this is not a real-time channel, and every beat costs a phone's data. A
 * lock ordered in the office reaches the handset within the quarter hour, which is faster
 * than anybody can get to a shop.
 */
public class BeatJob extends JobService {

    private static final int JOB_ID = 4711;
    private static final long PERIOD_MS = 15L * 60 * 1000;

    static void schedule(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, BeatJob.class))
                    .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
                    .setPeriodic(PERIOD_MS)
                    .setPersisted(true)          // survives reboot; RECEIVE_BOOT_COMPLETED backs it up
                    .build();
            js.schedule(job);
        } catch (Exception ignored) { }
    }

    static void cancel(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null) js.cancel(JOB_ID);
        } catch (Exception ignored) { }
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        final Context c = getApplicationContext();
        new Thread(() -> {
            /* The grace check runs FIRST and runs whether or not the network answers. That is
               the point of it: it is the rule that applies precisely when the beat cannot. */
            Beat.enforceGrace(c);
            Beat.run(c, false);
            SelfUpdate.check(c);
            jobFinished(params, false);
        }).start();
        return true;   // still working on another thread
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;   // reschedule; a missed beat is only ever a delay
    }
}
