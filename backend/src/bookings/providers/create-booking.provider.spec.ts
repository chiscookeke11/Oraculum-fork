import { BadRequestException, ConflictException } from '@nestjs/common';
import { CreateBookingProvider } from './create-booking.provider';
import { isStrictBookingDate } from '../dto/create-booking.dto';
import { BookingStatus } from '../enums/booking-status.enum';
import { Workspace } from '../../workspaces/entities/workspace.entity';

const FIXED_NOW = new Date('2026-10-15T12:00:00Z');

describe('CreateBookingProvider interval overlap checks', () => {
  const originalBookingTimeZone = process.env.BOOKING_TIMEZONE;

  afterEach(() => {
    if (originalBookingTimeZone === undefined) {
      delete process.env.BOOKING_TIMEZONE;
    } else {
      process.env.BOOKING_TIMEZONE = originalBookingTimeZone;
    }
  });

  const queryBuilder = () => ({
    select: jest.fn().mockReturnThis(),
    setLock: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    getOne: jest.fn().mockResolvedValue({
      id: 'workspace-1',
      isActive: true,
      totalSeats: 2,
      hourlyRate: 100,
      name: 'Test workspace',
    }),
    getRawOne: jest.fn().mockResolvedValue({ booked: '0' }),
  });

  it('allows an adjacent booking because the end boundary is exclusive', async () => {
    const workspaceQuery = queryBuilder();
    const bookingQuery = queryBuilder();
    const manager = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(workspaceQuery)
        .mockReturnValueOnce(bookingQuery),
      create: jest.fn((_entity, value) => value),
      save: jest.fn().mockResolvedValue({ id: 'booking-1' }),
    };
    const provider = new CreateBookingProvider(
      {} as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { calculateAmount: jest.fn().mockReturnValue(100) } as never,
      { transaction: jest.fn((callback) => callback(manager)) } as never,
      {} as never,
      {
        invalidateBookingList: jest.fn().mockResolvedValue(undefined),
      } as never,
    );

    await provider.create(
      {
        workspaceId: 'workspace-1',
        planType: 'hourly' as never,
        startDate: '2026-10-16',
        endDate: '2026-10-17',
        seatCount: 1,
      },
      'user-1',
      FIXED_NOW,
    );

    expect(bookingQuery.andWhere).toHaveBeenCalledWith(
      'b.startDate < :endDate',
      { endDate: '2026-10-17' },
    );
    expect(bookingQuery.andWhere).toHaveBeenCalledWith(
      'b.endDate > :startDate',
      { startDate: '2026-10-16' },
    );
    expect(bookingQuery.andWhere).toHaveBeenCalledWith(
      'b.status IN (:...statuses)',
      { statuses: [BookingStatus.PENDING, BookingStatus.CONFIRMED] },
    );
  });

  it('serializes concurrent transactions before checking workspace capacity', async () => {
    const bookings: Array<{
      startDate: string;
      endDate: string;
      seatCount: number;
      status: BookingStatus;
    }> = [];
    const workspace = {
      id: 'workspace-1',
      isActive: true,
      totalSeats: 2,
      hourlyRate: 100,
      name: 'Test workspace',
    };
    let workspaceLocked = false;
    const lockWaiters: Array<() => void> = [];
    const acquireWorkspaceLock = async () => {
      if (!workspaceLocked) {
        workspaceLocked = true;
        return;
      }
      await new Promise<void>((resolve) => lockWaiters.push(resolve));
    };
    const releaseWorkspaceLock = () => {
      const nextWaiter = lockWaiters.shift();
      if (nextWaiter) {
        nextWaiter();
      } else {
        workspaceLocked = false;
      }
    };

    const dataSource = {
      transaction: jest.fn(async (callback) => {
        let ownsWorkspaceLock = false;
        const manager = {
          createQueryBuilder: jest.fn((entity) => {
            if (entity === Workspace) {
              let lockRequested = false;
              const builder = {
                setLock: jest.fn(() => {
                  lockRequested = true;
                  return builder;
                }),
                where: jest.fn().mockReturnThis(),
                getOne: jest.fn(async () => {
                  if (lockRequested) {
                    await acquireWorkspaceLock();
                    ownsWorkspaceLock = true;
                  }
                  return workspace;
                }),
              };
              return builder;
            }

            const builder = {
              select: jest.fn().mockReturnThis(),
              where: jest.fn().mockReturnThis(),
              andWhere: jest.fn().mockReturnThis(),
              getRawOne: jest.fn(async () => ({
                booked: String(
                  bookings
                    .filter(
                      (booking) =>
                        booking.status === BookingStatus.PENDING ||
                        booking.status === BookingStatus.CONFIRMED,
                    )
                    .reduce((total, booking) => total + booking.seatCount, 0),
                ),
              })),
            };
            return builder;
          }),
          create: jest.fn((_entity, value) => value),
          save: jest.fn(async (booking) => {
            bookings.push(booking);
            return { id: `booking-${bookings.length}`, ...booking };
          }),
        };

        try {
          return await callback(manager);
        } finally {
          if (ownsWorkspaceLock) {
            releaseWorkspaceLock();
          }
        }
      }),
    };
    const provider = new CreateBookingProvider(
      {} as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { calculateAmount: jest.fn().mockReturnValue(100) } as never,
      dataSource as never,
      {} as never,
      { invalidateBookingList: jest.fn().mockResolvedValue(undefined) } as never,
    );
    const request = {
      workspaceId: 'workspace-1',
      planType: 'hourly' as never,
      startDate: '2026-10-16',
      endDate: '2026-10-17',
      seatCount: 2,
    };

    const results = await Promise.allSettled([
      provider.create(request, 'user-1', FIXED_NOW),
      provider.create(request, 'user-2', FIXED_NOW),
    ]);

    expect(dataSource.transaction).toHaveBeenCalledTimes(2);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toBeDefined();
    expect(rejected?.status === 'rejected' && rejected.reason).toBeInstanceOf(
      ConflictException,
    );
    expect(bookings.reduce((total, booking) => total + booking.seatCount, 0)).toBe(2);
  });

  it('rejects a booking whose end is not after its start', async () => {
    const provider = new CreateBookingProvider(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
    );

    await expect(
      provider.create(
        {
          workspaceId: 'workspace-1',
          planType: 'hourly' as never,
          startDate: '2026-10-17',
          endDate: '2026-10-17',
          seatCount: 1,
        },
        'user-1',
        FIXED_NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects recurring bookings with invalid or non-increasing end dates before opening a transaction', async () => {
    const transaction = jest.fn();
    const provider = new CreateBookingProvider(
      {} as never,
      {} as never,
      {} as never,
      { transaction } as never,
      {} as never,
      {} as never,
    );

    await expect(
      provider.createRecurring(
        {
          workspaceId: 'workspace-1',
          planType: 'hourly' as never,
          startDate: '2026-02-30',
          endDate: '2026-03-01',
          seatCount: 1,
          recurrenceFrequency: 'weekly' as never,
          occurrenceCount: 2,
        },
        'user-1',
        FIXED_NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      provider.createRecurring(
        {
          workspaceId: 'workspace-1',
          planType: 'hourly' as never,
          startDate: '2026-10-17',
          endDate: '2026-10-17',
          seatCount: 1,
          recurrenceFrequency: 'weekly' as never,
          occurrenceCount: 2,
        },
        'user-1',
        FIXED_NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('rejects a start date that is already past in the configured timezone', async () => {
    process.env.BOOKING_TIMEZONE = 'Africa/Lagos';
    const transaction = jest.fn();
    const provider = new CreateBookingProvider(
      {} as never,
      {} as never,
      {} as never,
      { transaction } as never,
      {} as never,
      {} as never,
    );

    await expect(
      provider.create(
        {
          workspaceId: 'workspace-1',
          planType: 'hourly' as never,
          startDate: '2026-10-16',
          endDate: '2026-10-17',
          seatCount: 1,
        },
        'user-1',
        new Date('2026-10-16T23:30:00Z'),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });

  it('accepts a start date that is today in the configured timezone', async () => {
    process.env.BOOKING_TIMEZONE = 'Africa/Lagos';
    const workspaceQuery = queryBuilder();
    const bookingQuery = queryBuilder();
    const save = jest.fn().mockResolvedValue({ id: 'booking-1' });
    const manager = {
      createQueryBuilder: jest
        .fn()
        .mockReturnValueOnce(workspaceQuery)
        .mockReturnValueOnce(bookingQuery),
      create: jest.fn((_entity, value) => value),
      save,
    };
    const transaction = jest.fn((callback) => callback(manager));
    const provider = new CreateBookingProvider(
      {} as never,
      { findOne: jest.fn().mockResolvedValue(null) } as never,
      { calculateAmount: jest.fn().mockReturnValue(100) } as never,
      { transaction } as never,
      {} as never,
      { invalidateBookingList: jest.fn().mockResolvedValue(undefined) } as never,
    );

    await provider.create(
      {
        workspaceId: 'workspace-1',
        planType: 'hourly' as never,
        startDate: '2026-10-17',
        endDate: '2026-10-18',
        seatCount: 1,
      },
      'user-1',
      new Date('2026-10-16T23:30:00Z'),
    );

    expect(transaction).toHaveBeenCalledTimes(1);
    expect(save).toHaveBeenCalledTimes(1);
  });
});


describe('strict booking date validation (BE-25)', () => {
  it.each([
    '2026-02-30',
    '2026-13-01',
    '2026-04-31',
    '2026-10-17T09:30:00',
    '2026-10-17T09:30:00.1234Z',
    '2026-10-17T24:00:00Z',
    '2026-10-17T09:60:00Z',
    '2026-10-17T09:30:60Z',
    '2026-10-17T09:30:00+14:01',
    'not-a-date',
    '',
  ])('rejects invalid or ambiguous input: %s', (value) => {
    expect(isStrictBookingDate(value)).toBe(false);
  });

  it.each([
    '2026-02-28',
    '2024-02-29',
    '2026-10-17T09:30:00Z',
    '2026-10-17T09:30:00.123Z',
    '2026-10-17T10:30:00+01:00',
    '2026-10-17T00:00:00-14:00',
  ])('accepts documented date/instant format: %s', (value) => {
    expect(isStrictBookingDate(value)).toBe(true);
  });

  it('compares offset timestamps as instants and rejects equal or reversed boundaries', () => {
    const start = '2026-10-17T10:00:00+01:00';
    expect(Date.parse('2026-10-17T10:00:01+01:00')).toBeGreaterThan(Date.parse(start));
    expect(Date.parse('2026-10-17T09:00:00Z')).toBe(Date.parse(start));
    expect(Date.parse('2026-10-17T08:59:59Z')).toBeLessThan(Date.parse(start));
  });

  it('rejects malformed booking dates before opening a transaction', async () => {
    const transaction = jest.fn();
    const provider = new CreateBookingProvider(
      {} as never,
      {} as never,
      {} as never,
      { transaction } as never,
      {} as never,
      {} as never,
    );

    await expect(
      provider.create(
        {
          workspaceId: 'workspace-1',
          planType: 'hourly' as never,
          startDate: '2026-10-17T10:00:00',
          endDate: '2026-10-18T10:00:00Z',
          seatCount: 1,
        },
        'user-1',
        FIXED_NOW,
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(transaction).not.toHaveBeenCalled();
  });
});
