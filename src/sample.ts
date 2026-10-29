export const SAMPLE_SQL = `INSERT INTO dbo.Customers
    (CustomerId, CustomerName, Age, IsActive)
VALUES
    (1, 'John Doe', 28, 1),
    (2, 'Jane Smith', 32, 0),
    (3, 'Robert Brown', NULL, 1);

INSERT INTO [MyDatabase].[dbo].[Order Details]
    ([Order Id], [Customer Name], [Note], [Price], [Created], [Token])
VALUES
    (1, N'Zoë O''Brien', 'Keyboard, Mechanical', 125.50, GETDATE(), 0xAB12),
    (2, 'Bob', '', -2.75, '2024-05-01T10:30:00', NEWID()),
    (3, 'NULL', NULL, 999.99, GETDATE(), 0x);
`
