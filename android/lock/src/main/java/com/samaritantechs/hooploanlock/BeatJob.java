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

    /* THE SECOND JOB, and why fifteen minutes could not simply be made smaller.
       =========================================================================================
         "funga and fungua and release should not take even a minute they should all be
          immediate effect whenever online and phone pings"

       JobScheduler's floor for a PERIODIC job is fifteen minutes -- setPeriodic with anything
       less is silently raised to it, so shortening the beat that way is not available at any
       price. A one-shot job has no such floor, so the follow-up below is how the phone comes
       back sooner, rescheduled after every beat.

       It runs on one of two grounds, and the difference is whose money is being spent:

         AN ORDER IS OUTSTANDING. The server said come back in seconds because the register and
         the handset disagree -- a lock ordered and not yet carried out. Any network, because
         this is the case that matters and the window is seconds long.

         IT IS SITTING ON THE BENCH. Charging AND on unmetered wifi, which is exactly Sipho's
         station and nowhere else. Android itself enforces both, so this job simply never runs
         on a customer's phone out in Dar on cellular -- it costs them nothing, and needs no
         cleverness here to decide that.

       What neither can do is wake a sleeping phone that has nothing pending and is not on the
       bench: the office presses Funga and that handset still finds out at its next ordinary
       beat. Beating that needs a push channel (FCM). Polling faster cannot get there without
       spending a customer's data bundle all day to say "still locked". */
    private static final int SOON_ID = 4712;
    private static final long BENCH_MS = 60L * 1000;

    static void schedule(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null) return;
            /* NO NETWORK CONSTRAINT ON THE PERIODIC BEAT, and that is the whole point of it.
               -----------------------------------------------------------------------------
                 "wifi is off, let me connect it"     "the reset took it off"

               This used to ask for NETWORK_TYPE_ANY, which reads as thrift and was a
               deadlock. A job with a network requirement DOES NOT RUN while there is no
               network -- so a handset that went offline never woke, and an app that never
               wakes cannot notice it is offline or turn the radio back on. Being offline
               kept itself that way, on a locked phone whose holder cannot reach Settings to
               fix it because the screen is pinned.

               Thirty-five minutes of a released handset staying locked came out of this one
               line. Waking without a network is nearly free: Net.online answers from the
               system, and a beat with no route fails immediately on DNS rather than waiting
               out a timeout. Being able to heal is worth that much. */
            JobInfo job = new JobInfo.Builder(JOB_ID, new ComponentName(c, BeatJob.class))
                    .setPeriodic(PERIOD_MS)
                    .setPersisted(true)          // survives reboot; RECEIVE_BOOT_COMPLETED backs it up
                    .build();
            js.schedule(job);
        } catch (Exception ignored) { }
    }

    /** Queue the next early check-in, if this phone has earned one. Called after every beat. */
    static void scheduleSoon(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js == null || Prefs.of(c).getBoolean(Prefs.RETIRED, false)) return;
            long wait = Prefs.of(c).getLong(Prefs.NEXT_BEAT, 0) * 1000L;
            boolean pending = wait > 0 && wait < PERIOD_MS;
            JobInfo.Builder b = new JobInfo.Builder(SOON_ID, new ComponentName(c, BeatJob.class))
                    .setMinimumLatency(pending ? wait : BENCH_MS)
                    // A deadline, or Doze can hold a one-shot indefinitely on an idle handset.
                    .setOverrideDeadline((pending ? wait : BENCH_MS) + 30_000L);
            if (pending) {
                b.setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY);
            } else {
                // The bench, and only the bench. Android decides, so a field phone is exempt
                // by construction rather than by a rule this code has to get right.
                b.setRequiredNetworkType(JobInfo.NETWORK_TYPE_UNMETERED).setRequiresCharging(true);
            }
            js.schedule(b.build());
        } catch (Exception ignored) { }
    }

    static void cancel(Context c) {
        try {
            JobScheduler js = (JobScheduler) c.getSystemService(Context.JOB_SCHEDULER_SERVICE);
            if (js != null) { js.cancel(JOB_ID); js.cancel(SOON_ID); }
        } catch (Exception ignored) { }
    }

    @Override
    public boolean onStartJob(final JobParameters params) {
        final Context c = getApplicationContext();
        new Thread(() -> {
            /* The grace check runs FIRST and runs whether or not the network answers. That is
               the point of it: it is the rule that applies precisely when the beat cannot. */
            Beat.enforceGrace(c);
            /* AND THE BOOT WINDOW IS CLOSED HERE TOO, because a window that fails to close is
               a phone that is not locked. openWindow() posts a timer, and a timer is worth
               exactly as much as the process holding it -- on a handset that has just finished
               booting, being killed is ordinary rather than exceptional. This runs on the
               system's schedule instead of ours, so a dead timer costs a few extra minutes
               rather than costing the lock. */
            Guard.enforce(c);
            Beat.run(c, false);
            SelfUpdate.check(c);
            // Queue the next early check-in, if this phone has earned one. Always after the
            // beat, so it acts on the pace the server just asked for.
            scheduleSoon(c);
            jobFinished(params, false);
        }).start();
        return true;   // still working on another thread
    }

    @Override
    public boolean onStopJob(JobParameters params) {
        return true;   // reschedule; a missed beat is only ever a delay
    }
}
